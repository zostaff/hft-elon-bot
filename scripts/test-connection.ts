/**
 * test-connection.ts — Phase-0 smoke test.
 *
 * Verifies:
 *   1. Config loads without errors
 *   2. SQLite opens and schema applies
 *   3. Gamma API is reachable and returns current Elon tweet markets
 *
 * No CLOB credentials required. Safe to run without .env (uses defaults).
 *
 * Usage:  npm run smoke
 */

import { request } from 'undici';
import { config } from '../src/config.js';
import { logger } from '../src/lib/logger.js';
import { db, recordMarket, listOpenMarkets, closeDb } from '../src/data/db.js';

const log = logger.child({ mod: 'smoke' });

interface GammaMarket {
  groupItemTitle?: string;
  clobTokenIds?: string | string[];
  conditionId?: string;
  lastTradePrice?: number | string | null;
}

interface GammaEvent {
  slug: string;
  title?: string;
  startDate?: string;
  endDate?: string;
  negRisk?: boolean;
  markets?: GammaMarket[];
}

function durationDays(start: string, end: string): number {
  return (
    (new Date(end).getTime() - new Date(start).getTime()) / (1000 * 60 * 60 * 24)
  );
}

async function fetchElonEvents(): Promise<GammaEvent[]> {
  const url =
    `${config.gammaHost}/events` +
    `?tag_id=972&closed=false&limit=30&order=startDate&ascending=false`;
  const t0 = performance.now();
  const { statusCode, body } = await request(url, {
    method: 'GET',
    headersTimeout: 5000,
    bodyTimeout: 5000,
  });
  if (statusCode !== 200) {
    throw new Error(`Gamma returned HTTP ${statusCode}`);
  }
  const data = (await body.json()) as GammaEvent[];
  const elapsed = (performance.now() - t0).toFixed(1);
  log.info({ ms: elapsed, total: data.length }, 'gamma /events fetched');
  return data.filter((e) =>
    (e.slug ?? '').toLowerCase().includes(config.discovery.targetUserSlug)
  );
}

async function main(): Promise<void> {
  log.info({ host: config.gammaHost }, 'smoke test: gamma + db');

  // 1) DB ping
  const rows = db.prepare(`SELECT COUNT(*) AS n FROM markets`).get() as {
    n: number;
  };
  log.info({ existingMarkets: rows.n }, 'db query ok');

  // 2) Gamma API
  const elonEvents = await fetchElonEvents();
  log.info({ matched: elonEvents.length }, 'elon events filtered');

  for (const ev of elonEvents) {
    const start = ev.startDate ?? '';
    const end = ev.endDate ?? '';
    if (!start || !end) continue;
    const days = durationDays(start, end);

    const inWindow =
      days >= config.discovery.marketMinDays &&
      days <= config.discovery.marketMaxDays;

    const buckets = (ev.markets ?? [])
      .map((m) => m.groupItemTitle)
      .filter((t): t is string => Boolean(t));

    log.info(
      {
        slug: ev.slug,
        durationDays: Number(days.toFixed(2)),
        buckets: buckets.length,
        negRisk: Boolean(ev.negRisk),
        target: inWindow ? '✓ in 2-day window' : '— skip',
      },
      ev.slug
    );

    if (inWindow) {
      const isNew = recordMarket({
        slug: ev.slug,
        question: ev.title ?? null,
        negRisk: Boolean(ev.negRisk),
        startTs: start,
        endTs: end,
        durationDays: days,
      });
      log.info(
        { slug: ev.slug, persisted: isNew ? 'new' : 'already-known' },
        `db insert: ${ev.slug}`
      );
    }
  }

  // 3) Recap
  const open = listOpenMarkets();
  log.info({ openMarkets: open.length }, 'open markets in db');

  closeDb();
  log.info('smoke test ok ✓');
}

main().catch((err) => {
  log.fatal({ err }, 'smoke test failed');
  process.exit(1);
});
