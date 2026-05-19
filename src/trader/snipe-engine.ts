/**
 * snipe-engine.ts — orchestrator for one snipe.
 *
 *   MarketCandidate → ladder gen → inventory check → executor (paper|live)
 *
 * Stays mode-agnostic: the executor dispatch is a single switch. Phase 3
 * adds the `live` branch with CLOB V2 calls; for now it's paper-only.
 */

import { performance } from 'node:perf_hooks';
import { logger } from '../lib/logger.js';
import { config } from '../config.js';
import { logEvent } from '../data/db.js';
import { generateLadder, type LadderPlan } from './ladder.js';
import { inventory } from '../risk/inventory.js';
import { placePaperBatch, type PaperResult } from '../exec/paper.js';
import { placeLiveBatch, type LiveResult } from '../exec/live.js';
import { fetchMarketInfo, alignPriceDown } from '../lib/clob.js';
import { killSwitch } from '../risk/kill-switch.js';
import type { MarketCandidate } from '../types.js';

const log = logger.child({ mod: 'snipe' });

export interface SnipeOutcome {
  slug: string;
  mode: 'paper' | 'live';
  planned: number;
  placed: number;
  failed: number;
  skipped: number;
  totalUsd: number;
  totalLatencyMs: number;
  /** undefined when not approved. */
  approval?:
    | { allowed: true }
    | { allowed: false; reason: string; capUsd: number; currentUsd: number; wantedUsd: number };
}

export class SnipeEngine {
  constructor(private readonly mode: 'paper' | 'live' = config.tradeMode) {
    log.info({ mode: this.mode }, 'snipe engine ready');
  }

  /**
   * Handle one discovered market: generate ladder, gate on inventory,
   * dispatch to executor. Returns a summary.
   */
  async handle(candidate: MarketCandidate): Promise<SnipeOutcome> {
    const t0 = performance.now();

    const plan = generateLadder(candidate);
    this.logPlan(candidate, plan);

    if (plan.orders.length === 0) {
      log.warn(
        { slug: candidate.slug, skipped: plan.skipped.length },
        'no orders to place (all skipped — likely budget too small)'
      );
      logEvent('warn', 'snipe_no_orders', {
        slug: candidate.slug,
        skipped: plan.skipped.length,
      });
      return {
        slug: candidate.slug,
        mode: this.mode,
        planned: 0,
        placed: 0,
        failed: 0,
        skipped: plan.skipped.length,
        totalUsd: 0,
        totalLatencyMs: 0,
      };
    }

    // Inventory gate
    const approval = inventory.approve(candidate.slug, plan.totalUsd);
    if (!approval.allowed) {
      log.warn(
        { slug: candidate.slug, ...approval },
        '🛑 snipe blocked by inventory cap'
      );
      logEvent('warn', 'snipe_blocked', {
        slug: candidate.slug,
        ...approval,
      });
      return {
        slug: candidate.slug,
        mode: this.mode,
        planned: plan.orders.length,
        placed: 0,
        failed: 0,
        skipped: plan.skipped.length,
        totalUsd: 0,
        totalLatencyMs: 0,
        approval,
      };
    }

    // Reserve capital BEFORE placing — if any order fails we release later.
    inventory.register(candidate.slug, plan.totalUsd);

    // Dispatch
    let results: Array<PaperResult | LiveResult>;
    if (this.mode === 'paper') {
      results = placePaperBatch(candidate.slug, plan.orders);
    } else {
      // Live: look up tick size + align ladder prices to grid before sending.
      if (killSwitch.isTripped()) {
        log.error(
          { slug: candidate.slug, reason: killSwitch.trippedReasonText() },
          'live snipe refused — kill switch tripped'
        );
        inventory.release(candidate.slug, plan.totalUsd);
        return {
          slug: candidate.slug,
          mode: this.mode,
          planned: plan.orders.length,
          placed: 0,
          failed: 0,
          skipped: plan.skipped.length,
          totalUsd: 0,
          totalLatencyMs: Math.round(performance.now() - t0),
        };
      }

      const conditionId = candidate.buckets[0]?.conditionId;
      let tickSize = '0.01';
      if (conditionId) {
        try {
          const info = await fetchMarketInfo(conditionId);
          tickSize = info.tickSize;
          log.info(
            { slug: candidate.slug, tickSize, mos: info.minOrderSize },
            'live: fetched market info'
          );
        } catch (e) {
          log.warn(
            { err: (e as Error).message, slug: candidate.slug },
            'live: fetchMarketInfo failed, defaulting tickSize=0.01'
          );
        }
      } else {
        log.warn(
          { slug: candidate.slug },
          'live: no conditionId on candidate, defaulting tickSize=0.01'
        );
      }

      // Align ladder prices to tick (round DOWN — never overpay our limit)
      const alignedOrders = plan.orders.map((o) => ({
        ...o,
        price: alignPriceDown(o.price, tickSize),
      }));
      const liveResults = await placeLiveBatch(
        candidate.slug,
        alignedOrders,
        { tickSize }
      );
      results = liveResults;
    }

    const placed = results.filter((r) => r.ok).length;
    const failed = results.length - placed;
    const placedUsd = results
      .map((r, i) => (r.ok ? (plan.orders[i]?.sizeUsd ?? 0) : 0))
      .reduce((a, b) => a + b, 0);
    const failedUsd = plan.totalUsd - placedUsd;
    if (failedUsd > 0) inventory.release(candidate.slug, failedUsd);

    const totalLatencyMs = Math.round(performance.now() - t0);
    log.info(
      {
        slug: candidate.slug,
        mode: this.mode,
        planned: plan.orders.length,
        placed,
        failed,
        skipped: plan.skipped.length,
        totalUsd: Math.round(placedUsd * 100) / 100,
        totalLatencyMs,
        invStats: inventory.getStats(),
      },
      '✅ SNIPE COMPLETE'
    );

    logEvent('info', 'snipe_complete', {
      slug: candidate.slug,
      mode: this.mode,
      planned: plan.orders.length,
      placed,
      failed,
      placedUsd: Math.round(placedUsd * 100) / 100,
      totalLatencyMs,
    });

    return {
      slug: candidate.slug,
      mode: this.mode,
      planned: plan.orders.length,
      placed,
      failed,
      skipped: plan.skipped.length,
      totalUsd: Math.round(placedUsd * 100) / 100,
      totalLatencyMs,
      approval,
    };
  }

  private logPlan(candidate: MarketCandidate, plan: LadderPlan): void {
    log.info(
      {
        slug: candidate.slug,
        buckets: plan.numBuckets,
        levels: plan.numLevels,
        perBucketBudgetUsd: plan.perBucketBudgetUsd,
        plannedOrders: plan.orders.length,
        skippedSlots: plan.skipped.length,
        totalUsd: plan.totalUsd,
      },
      'snipe plan generated'
    );
    if (plan.skipped.length > 0) {
      log.warn(
        {
          slug: candidate.slug,
          skipped: plan.skipped.slice(0, 3),
          totalSkipped: plan.skipped.length,
        },
        'some ladder slots skipped (below MIN_ORDER_USD)'
      );
    }
  }
}
