/**
 * simulate-snipe.ts — force-feed the snipe engine a real current market
 * so we can verify the end-to-end pipeline without waiting 2 days for a
 * real `new_market` event.
 *
 * Picks the first Elon 2-day market currently on Gamma, builds a
 * MarketCandidate from it (as if it had just been discovered), and runs
 * the SnipeEngine on it in paper mode. Wipes any prior paper orders for
 * that slug first so the inventory cap doesn't block us on re-runs.
 *
 * Usage:  npx tsx scripts/simulate-snipe.ts
 */

import { config } from '../src/config.js';
import { logger } from '../src/lib/logger.js';
import { db, closeDb } from '../src/data/db.js';
import { fetchTweetEvents, closeGamma, durationDays } from '../src/lib/gamma.js';
import { evaluateEvent, buildCandidate } from '../src/discovery/filter.js';
import { SnipeEngine } from '../src/trader/snipe-engine.js';
import { inventory } from '../src/risk/inventory.js';
import { generateLadder } from '../src/trader/ladder.js';
import type { GammaEvent } from '../src/types.js';

const log = logger.child({ mod: 'simulate' });

async function main(): Promise<void> {
  if (config.tradeMode !== 'paper') {
    log.fatal(
      { mode: config.tradeMode },
      'refusing to run simulate against live mode — set TRADE_MODE=paper'
    );
    process.exit(1);
  }

  const events = await fetchTweetEvents();
  log.info({ total: events.length }, 'fetched events');

  // First: log why each Elon event currently fails the filter (visibility)
  for (const e of events) {
    if (!e.slug.toLowerCase().includes(config.discovery.targetUserSlug)) continue;
    const v = evaluateEvent(e);
    const d = e.startDate && e.endDate ? durationDays(e.startDate, e.endDate) : null;
    log.info({ slug: e.slug, durationDays: d?.toFixed(2), pass: v.pass, reason: v.reason, topPrice: v.topPrice }, 'filter eval');
  }

  // Pick first 2-day Elon market in duration window (ignore freshness here —
  // current live markets are already traded, but on a NEW market the orderbook
  // is empty so we synthesize that condition by zeroing lastTradePrice).
  const candidateEvent = events.find((e) => {
    if (!e.slug.toLowerCase().includes(config.discovery.targetUserSlug)) return false;
    if (!e.startDate || !e.endDate) return false;
    const d = durationDays(e.startDate, e.endDate);
    return d >= config.discovery.marketMinDays && d <= config.discovery.marketMaxDays;
  });

  if (!candidateEvent) {
    log.error('no Elon 2-day market currently in duration window');
    process.exit(2);
  }

  // Synthesize a "fresh" market: clear lastTradePrice so freshness check passes
  const freshEvent: GammaEvent = {
    ...candidateEvent,
    markets: (candidateEvent.markets ?? []).map((m) => ({ ...m, lastTradePrice: 0 })),
  };
  log.info({ slug: freshEvent.slug }, 'synthesized fresh market (lastTradePrice → 0)');

  const verdict = evaluateEvent(freshEvent);
  if (!verdict.pass) {
    log.fatal({ verdict }, 'synthesized event still fails filter — bug in filter logic');
    process.exit(3);
  }

  const candidate = buildCandidate(freshEvent, 'poll', 0);
  log.info(
    {
      slug: candidate.slug,
      buckets: candidate.buckets.length,
      negRisk: candidate.negRisk,
      durationDays: candidate.durationDays.toFixed(2),
    },
    'simulated newMarket candidate'
  );

  // Reset state for clean run: wipe any prior paper orders/inventory for this slug
  const del = db
    .prepare(`DELETE FROM orders WHERE market_slug = ? AND mode = 'paper'`)
    .run(candidate.slug);
  log.info({ deleted: del.changes }, 'wiped prior paper orders for this slug');

  inventory.loadFromDb();
  log.info(inventory.getStats(), 'inventory before');

  // Show plan first so we can eyeball before committing
  const plan = generateLadder(candidate);
  log.info(
    {
      perBucketBudgetUsd: plan.perBucketBudgetUsd,
      planned: plan.orders.length,
      skipped: plan.skipped.length,
      totalUsd: plan.totalUsd,
      sample: plan.orders.slice(0, 3),
    },
    'ladder plan preview'
  );

  // Dispatch
  const engine = new SnipeEngine('paper');
  const result = await engine.handle(candidate);

  log.info(result, 'simulate-snipe RESULT');
  log.info(inventory.getStats(), 'inventory after');

  // Quick DB recap
  const ordersInDb = db
    .prepare(
      `SELECT status, COUNT(*) AS n, ROUND(SUM(size_usd),2) AS sum_usd
         FROM orders
        WHERE market_slug = ?
        GROUP BY status`
    )
    .all(candidate.slug);
  log.info({ slug: candidate.slug, breakdown: ordersInDb }, 'orders in db');

  await closeGamma();
  closeDb();
}

main().catch((err) => {
  log.fatal({ err }, 'simulate failed');
  process.exit(1);
});
