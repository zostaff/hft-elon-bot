/**
 * index.ts — entrypoint.
 *
 * Phase 2: discovery → snipe-engine (paper). Real orders come in Phase 3.
 */

import { config } from './config.js';
import { logger } from './lib/logger.js';
import { closeDb, logEvent } from './data/db.js';
import { closeGamma } from './lib/gamma.js';
import { warmupOnce, startKeepalive, stopKeepalive } from './lib/warmup.js';
import { DiscoveryManager } from './discovery/index.js';
import { SnipeEngine } from './trader/snipe-engine.js';
import { inventory } from './risk/inventory.js';

const log = logger.child({ mod: 'main' });

async function main(): Promise<void> {
  log.info(
    {
      mode: config.tradeMode,
      bankrollUsd: config.strategy.bankrollUsd,
      maxUsdPerMarket: config.strategy.maxUsdPerMarket,
      ladderPrices: config.strategy.ladderPrices,
      ladderSplit: config.strategy.ladderSplit,
      minOrderUsd: config.strategy.minOrderUsd,
      pollMs: config.discovery.pollIntervalMs,
      wsEnabled: config.discovery.wsEnabled,
    },
    `hft-elon-bot booting in ${config.tradeMode.toUpperCase()} mode`
  );

  logEvent('info', 'boot', { mode: config.tradeMode });

  // ── safety net: never let an unhandled promise rejection or stray
  //    exception take the bot down. Log + persist, then carry on. The bot
  //    is paper-mode-safe; live-mode is gated by kill-switch in Phase 3.
  process.on('unhandledRejection', (reason) => {
    log.error({ reason: String(reason) }, 'UNHANDLED PROMISE REJECTION');
    logEvent('error', 'unhandled_rejection', { reason: String(reason) });
  });
  process.on('uncaughtException', (err) => {
    log.error(
      { err: err.message, stack: err.stack },
      'UNCAUGHT EXCEPTION'
    );
    logEvent('error', 'uncaught_exception', {
      err: err.message,
      stack: err.stack ?? null,
    });
  });

  inventory.loadFromDb();
  const snipe = new SnipeEngine(config.tradeMode);

  // Warm Gamma/CLOB/signer paths BEFORE discovery starts firing.
  // Crashes are non-fatal — paper mode doesn't need CLOB, and discovery has
  // its own retry logic for Gamma.
  await warmupOnce().catch((err) =>
    log.warn({ err: (err as Error).message }, 'warmup threw, continuing anyway')
  );
  startKeepalive();

  const discovery = new DiscoveryManager();
  discovery.on('newMarket', (candidate) => {
    // Fire-and-forget; snipe.handle handles its own errors.
    void snipe.handle(candidate).catch((err) => {
      log.error(
        { err: (err as Error).message, slug: candidate.slug },
        'snipe.handle threw'
      );
    });
  });

  discovery.start();

  // ── graceful shutdown ───────────────────────────────────────
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.warn({ signal }, 'shutdown initiated');
    logEvent('info', 'shutdown', { signal });
    try {
      discovery.stop();
      stopKeepalive();
      await closeGamma();
      closeDb();
    } catch (e) {
      log.error({ err: e }, 'shutdown cleanup failed');
    }
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await new Promise<void>(() => {
    /* run forever */
  });
}

main().catch((err) => {
  log.fatal({ err }, 'fatal error in main');
  process.exit(1);
});
