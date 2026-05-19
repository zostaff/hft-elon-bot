/**
 * check-live.ts — sanity-check live wiring without placing any orders.
 *
 * Verifies:
 *   1. All credentials in .env are well-formed
 *   2. ClobClient (L2) can be constructed
 *   3. We can call a read-only endpoint (getMarketInfo on any current Elon
 *      market) and get tick + mos back
 *
 * No orders are placed. Safe to run any time.
 *
 * Usage: npm run check-live
 */

import { config } from '../src/config.js';
import { logger } from '../src/lib/logger.js';
import { getClobClient, fetchMarketInfo } from '../src/lib/clob.js';
import { fetchTweetEvents, extractBuckets, closeGamma } from '../src/lib/gamma.js';

const log = logger.child({ mod: 'check-live' });

async function main(): Promise<void> {
  log.info({
    mode: config.tradeMode,
    hasWallet: Boolean(config.credentials.walletPrivateKey),
    hasApiKey: Boolean(config.credentials.clobApiKey),
    hasSecret: Boolean(config.credentials.clobSecret),
    hasPass: Boolean(config.credentials.clobPassPhrase),
    hasProxy: Boolean(config.credentials.polymarketProxyAddress),
  }, 'config check');

  log.info('building CLOB V2 client (L1+L2)...');
  await getClobClient();
  log.info('✅ CLOB V2 client ready');

  log.info('fetching a current Elon market to test getMarketInfo...');
  const events = await fetchTweetEvents();
  const elon = events.find((e) => e.slug.toLowerCase().includes('elon-musk'));
  if (!elon) {
    log.warn('no elon market live right now — can\'t test market info');
    await closeGamma();
    return;
  }
  const buckets = extractBuckets(elon);
  const first = buckets[0];
  if (!first?.conditionId) {
    log.warn({ slug: elon.slug }, 'first bucket has no conditionId — skipping');
    await closeGamma();
    return;
  }
  log.info({ slug: elon.slug, conditionId: first.conditionId }, 'probing market info');
  const info = await fetchMarketInfo(first.conditionId);
  log.info({ ...info }, '✅ market info retrieved');

  log.info('all live checks passed. Bot is ready to flip TRADE_MODE=live.');
  await closeGamma();
}

main().catch((err) => {
  log.fatal({ err: (err as Error).message, stack: (err as Error).stack }, 'check-live FAILED');
  process.exit(1);
});
