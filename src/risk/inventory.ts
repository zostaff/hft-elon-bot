/**
 * inventory.ts — capital tracker + risk gate.
 *
 * Single source of truth for "how much have we committed where".
 * Persists nothing — DB is the ledger; this is just a fast in-memory cache
 * rebuilt from DB on start.
 *
 * Two limits enforced:
 *   1. MAX_USD_PER_MARKET  — cap per single market
 *   2. BANKROLL_USD        — cap across all markets
 *
 * Order outcomes:
 *   - approveAll(slug, totalUsd) → allowed | { allowed: false; reason }
 *   - register(slug, usd) → call after orders are actually placed
 */

import { db } from '../data/db.js';
import { config } from '../config.js';
import { logger } from '../lib/logger.js';

const log = logger.child({ mod: 'inventory' });

export type ApproveResult =
  | { allowed: true }
  | {
      allowed: false;
      reason: 'over_per_market_cap' | 'over_bankroll_cap';
      capUsd: number;
      currentUsd: number;
      wantedUsd: number;
    };

export class Inventory {
  /** USD committed per market slug (live + paper combined). */
  private perMarket = new Map<string, number>();
  /** Total USD committed across all markets. */
  private totalUsd = 0;

  /** Rebuild state from DB. Call on bot start. */
  loadFromDb(): void {
    this.perMarket.clear();
    this.totalUsd = 0;

    const rows = db
      .prepare<[], { market_slug: string; total: number }>(
        `SELECT market_slug, SUM(size_usd) AS total
           FROM orders
          WHERE status IN ('pending', 'placed', 'partial', 'filled')
          GROUP BY market_slug`
      )
      .all();

    for (const r of rows) {
      this.perMarket.set(r.market_slug, r.total);
      this.totalUsd += r.total;
    }

    log.info(
      {
        markets: this.perMarket.size,
        totalUsd: Math.round(this.totalUsd * 100) / 100,
      },
      'inventory loaded from db'
    );
  }

  /** Is this commit allowed under both per-market and total caps? */
  approve(slug: string, addUsd: number): ApproveResult {
    const perMarketCap = config.strategy.maxUsdPerMarket;
    const bankrollCap = config.strategy.bankrollUsd;

    const currentMarket = this.perMarket.get(slug) ?? 0;
    if (currentMarket + addUsd > perMarketCap + 1e-6) {
      return {
        allowed: false,
        reason: 'over_per_market_cap',
        capUsd: perMarketCap,
        currentUsd: currentMarket,
        wantedUsd: addUsd,
      };
    }

    if (this.totalUsd + addUsd > bankrollCap + 1e-6) {
      return {
        allowed: false,
        reason: 'over_bankroll_cap',
        capUsd: bankrollCap,
        currentUsd: this.totalUsd,
        wantedUsd: addUsd,
      };
    }

    return { allowed: true };
  }

  /** Call after orders are actually placed (any mode). */
  register(slug: string, addUsd: number): void {
    this.perMarket.set(slug, (this.perMarket.get(slug) ?? 0) + addUsd);
    this.totalUsd += addUsd;
  }

  /** Release capital (e.g. order rejected / canceled). */
  release(slug: string, removeUsd: number): void {
    const cur = this.perMarket.get(slug) ?? 0;
    const newVal = Math.max(0, cur - removeUsd);
    this.perMarket.set(slug, newVal);
    this.totalUsd = Math.max(0, this.totalUsd - removeUsd);
  }

  getStats(): {
    totalUsd: number;
    markets: number;
    bankrollUsd: number;
    free: number;
  } {
    const bankroll = config.strategy.bankrollUsd;
    return {
      totalUsd: Math.round(this.totalUsd * 100) / 100,
      markets: this.perMarket.size,
      bankrollUsd: bankroll,
      free: Math.round((bankroll - this.totalUsd) * 100) / 100,
    };
  }

  getMarketUsd(slug: string): number {
    return this.perMarket.get(slug) ?? 0;
  }
}

// Module-level singleton — there is only one bot, one bankroll.
export const inventory = new Inventory();
