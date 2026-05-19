/**
 * ladder.ts — pure ladder-order generator.
 *
 * Input: a MarketCandidate. Output: list of (bucket × price × size) BUY orders
 * we'd place on the YES side of each bucket, plus a list of skipped slots and
 * the total committed USD.
 *
 * Logic:
 *   per-bucket budget = MAX_USD_PER_MARKET / num_buckets
 *   for each ladder step:
 *       size_usd = per-bucket budget × split[step]
 *       if size_usd < MIN_ORDER_USD: skip (logged)
 *
 * No I/O, no side effects — fully unit-testable.
 */

import { config } from '../config.js';
import type { MarketCandidate } from '../types.js';

export interface LadderOrder {
  bucketTitle: string;
  tokenId: string;       // YES token
  price: number;
  sizeUsd: number;
  sizeShares: number;
}

export interface SkippedSlot {
  bucketTitle: string;
  level: number;
  price: number;
  wantedUsd: number;
  reason: 'below_min_order';
}

export interface LadderPlan {
  orders: LadderOrder[];
  skipped: SkippedSlot[];
  totalUsd: number;
  perBucketBudgetUsd: number;
  numBuckets: number;
  numLevels: number;
}

export function generateLadder(candidate: MarketCandidate): LadderPlan {
  const prices = config.strategy.ladderPrices;
  const splits = config.strategy.ladderSplit;
  const minOrder = config.strategy.minOrderUsd;
  const marketCap = config.strategy.maxUsdPerMarket;

  const buckets = candidate.buckets;
  const perBucket = marketCap / Math.max(1, buckets.length);

  const orders: LadderOrder[] = [];
  const skipped: SkippedSlot[] = [];

  for (const bucket of buckets) {
    for (let i = 0; i < prices.length; i++) {
      const price = prices[i]!;
      const split = splits[i]!;
      // round to cents to avoid float noise
      const rawSize = perBucket * split;
      const sizeUsd = Math.round(rawSize * 100) / 100;

      if (sizeUsd < minOrder) {
        skipped.push({
          bucketTitle: bucket.title,
          level: i,
          price,
          wantedUsd: sizeUsd,
          reason: 'below_min_order',
        });
        continue;
      }

      const sizeShares = Math.round((sizeUsd / price) * 100) / 100;
      orders.push({
        bucketTitle: bucket.title,
        tokenId: bucket.tokenIdYes,
        price,
        sizeUsd,
        sizeShares,
      });
    }
  }

  const totalUsd = Math.round(
    orders.reduce((acc, o) => acc + o.sizeUsd, 0) * 100
  ) / 100;

  return {
    orders,
    skipped,
    totalUsd,
    perBucketBudgetUsd: Math.round(perBucket * 100) / 100,
    numBuckets: buckets.length,
    numLevels: prices.length,
  };
}
