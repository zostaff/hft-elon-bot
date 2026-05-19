/**
 * latency.ts — measure network latency to Polymarket endpoints + summarize
 * past order latencies from DB.
 *
 * Use cases:
 *   - Before going live: confirm we're under ~80 ms to CLOB
 *   - Before VPS migration: get baseline from current host
 *   - After VPS migration: compare against baseline
 *
 * Usage:  npm run latency           # 10 samples
 *         npm run latency -- 50     # 50 samples
 */

import { performance } from 'node:perf_hooks';
import { request } from 'undici';
import { config } from '../src/config.js';
import { logger } from '../src/lib/logger.js';
import { db, closeDb } from '../src/data/db.js';

const log = logger.child({ mod: 'latency' });

interface Probe {
  name: string;
  url: string;
  method?: 'GET';
}

const PROBES: Probe[] = [
  { name: 'gamma', url: `${config.gammaHost}/events?tag_id=972&limit=1` },
  { name: 'clob ', url: `${config.clobHost}/time` },
  { name: 'clob-ob', url: `${config.clobHost}/markets?limit=1` },
];

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * q));
  return sorted[idx]!;
}

function summarize(name: string, samples: number[]): void {
  if (samples.length === 0) {
    log.warn({ probe: name }, 'no successful samples');
    return;
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const mean = sorted.reduce((a, b) => a + b, 0) / sorted.length;
  log.info(
    {
      probe: name,
      n: samples.length,
      min: sorted[0],
      p50: quantile(sorted, 0.5),
      p95: quantile(sorted, 0.95),
      p99: quantile(sorted, 0.99),
      max: sorted[sorted.length - 1],
      mean: Math.round(mean * 10) / 10,
    },
    `${name} latency`
  );
}

async function probeOnce(p: Probe): Promise<number | null> {
  const t0 = performance.now();
  try {
    const { statusCode, body } = await request(p.url, {
      method: 'GET',
      headersTimeout: 5_000,
      bodyTimeout: 5_000,
    });
    await body.dump();
    if (statusCode >= 500) return null;
    return performance.now() - t0;
  } catch {
    return null;
  }
}

async function runProbes(samples: number): Promise<void> {
  log.info({ samples, mode: 'cold→warm→steady' }, 'probing endpoints');
  log.info('first call includes DNS + TCP + TLS handshake; subsequent calls reuse pool');
  for (const p of PROBES) {
    const results: number[] = [];
    for (let i = 0; i < samples; i++) {
      const ms = await probeOnce(p);
      if (ms !== null) results.push(ms);
    }
    summarize(p.name, results);
  }
}

function reportOrderLatencyFromDb(): void {
  const rows = db
    .prepare(
      `SELECT mode, COUNT(*) AS n,
              MIN(latency_ms) AS min,
              ROUND(AVG(latency_ms),1) AS mean,
              MAX(latency_ms) AS max
         FROM orders
        WHERE latency_ms IS NOT NULL
        GROUP BY mode`
    )
    .all() as Array<{ mode: string; n: number; min: number; mean: number; max: number }>;

  if (rows.length === 0) {
    log.info('no order latency data in DB yet');
    return;
  }
  for (const r of rows) {
    log.info(r, `historical ${r.mode} order latency`);
  }
}

async function main(): Promise<void> {
  const arg = process.argv[2];
  const samples = arg ? Math.max(1, Math.min(200, parseInt(arg, 10))) : 10;

  await runProbes(samples);
  reportOrderLatencyFromDb();

  closeDb();
}

main().catch((err) => {
  log.fatal({ err }, 'latency probe failed');
  process.exit(1);
});
