/**
 * stats.ts — one-shot dashboard.
 *
 * Sections:
 *   1. Boot info (mode, uptime if bot running)
 *   2. Markets detected (status breakdown)
 *   3. Orders (mode × status × count × Σ usd)
 *   4. Last 5 snipes (per-market summary)
 *   5. Latency (paper & live)
 *   6. Inventory state (what DB says committed)
 *   7. Last 10 events
 *
 * Usage: npm run stats
 */

import { readFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { config } from '../src/config.js';
import { db, closeDb } from '../src/data/db.js';
import { logger } from '../src/lib/logger.js';

const log = logger.child({ mod: 'dashboard' });

function botStatus(): { pid: number | null; uptime: string | null } {
  const pidFile = './data/bot.pid';
  if (!existsSync(pidFile)) return { pid: null, uptime: null };
  try {
    const pid = parseInt(readFileSync(pidFile, 'utf8').trim(), 10);
    if (!Number.isFinite(pid)) return { pid: null, uptime: null };
    const out = execSync(`ps -p ${pid} -o etime= 2>/dev/null || true`, {
      encoding: 'utf8',
    }).trim();
    if (!out) return { pid, uptime: null };
    return { pid, uptime: out };
  } catch {
    return { pid: null, uptime: null };
  }
}

function divider(title: string): void {
  // eslint-disable-next-line no-console
  console.log(`\n─── ${title} ${'─'.repeat(Math.max(0, 60 - title.length))}`);
}

function main(): void {
  const status = botStatus();
  log.info(
    {
      mode: config.tradeMode,
      bankrollUsd: config.strategy.bankrollUsd,
      maxUsdPerMarket: config.strategy.maxUsdPerMarket,
      ladderPrices: config.strategy.ladderPrices,
      botPid: status.pid,
      botUptime: status.uptime,
    },
    'hft-elon-bot dashboard'
  );

  // 1. Markets
  divider('markets');
  const markets = db
    .prepare(
      `SELECT status, COUNT(*) AS n FROM markets GROUP BY status ORDER BY status`
    )
    .all() as Array<Record<string, unknown>>;
  log.info({ breakdown: markets }, 'markets by status');

  // 2. Orders
  divider('orders');
  const orders = db
    .prepare(
      `SELECT mode, status, COUNT(*) AS n, ROUND(SUM(size_usd),2) AS sum_usd
         FROM orders GROUP BY mode, status ORDER BY mode, status`
    )
    .all() as Array<Record<string, unknown>>;
  log.info({ breakdown: orders }, 'orders by mode × status');

  // 3. Recent snipes — per-market summary
  divider('last 5 snipes (markets)');
  const snipes = db
    .prepare(
      `SELECT market_slug, mode, COUNT(*) AS n_orders,
              ROUND(SUM(size_usd),2) AS sum_usd,
              MIN(placed_at) AS first_order,
              MAX(placed_at) AS last_order
         FROM orders
        GROUP BY market_slug, mode
        ORDER BY MAX(placed_at) DESC
        LIMIT 5`
    )
    .all() as Array<Record<string, unknown>>;
  for (const row of snipes) log.info(row, `snipe ${String(row.market_slug)}`);

  // 4. Latency
  divider('latency');
  const lat = db
    .prepare(
      `SELECT mode,
              COUNT(*) AS n,
              MIN(latency_ms) AS min_ms,
              ROUND(AVG(latency_ms),1) AS mean_ms,
              MAX(latency_ms) AS max_ms
         FROM orders
        WHERE latency_ms IS NOT NULL
        GROUP BY mode`
    )
    .all() as Array<Record<string, unknown>>;
  if (lat.length === 0) {
    log.info('no latency data yet');
  } else {
    for (const r of lat) log.info(r, `${String(r.mode)} latency`);
  }

  // 5. Inventory (computed live from DB to cross-check)
  divider('inventory (computed from DB)');
  const inv = db
    .prepare(
      `SELECT COUNT(DISTINCT market_slug) AS markets,
              ROUND(SUM(size_usd),2) AS committed_usd
         FROM orders
        WHERE status IN ('pending','placed','partial','filled')`
    )
    .get() as { markets: number; committed_usd: number | null };
  const committed = inv.committed_usd ?? 0;
  log.info(
    {
      markets: inv.markets,
      committedUsd: committed,
      bankrollUsd: config.strategy.bankrollUsd,
      freeUsd: Math.round((config.strategy.bankrollUsd - committed) * 100) / 100,
    },
    'inventory'
  );

  // 6. Events
  divider('last 10 events');
  const events = db
    .prepare(
      `SELECT ts, level, kind, payload
         FROM events
        ORDER BY id DESC LIMIT 10`
    )
    .all() as Array<Record<string, unknown>>;
  for (const e of events) log.info(e, String(e.kind));

  closeDb();
}

main();
