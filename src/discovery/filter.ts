/**
 * filter.ts — pure predicates for "is this a market we want to snipe?"
 *
 * No I/O. Pure data in, pure data out. Easy to unit-test in isolation.
 */

import { config } from '../config.js';
import { durationDays, extractBuckets } from '../lib/gamma.js';
import type { GammaEvent, MarketCandidate } from '../types.js';

export type FilterReason =
  | 'ok'
  | 'wrong_user'
  | 'closed'
  | 'missing_dates'
  | 'duration_out_of_range'
  | 'no_buckets'
  | 'already_traded';

export interface FilterResult {
  pass: boolean;
  reason: FilterReason;
  durationDays?: number;
  topPrice?: number;
}

/**
 * Evaluate a Gamma event against the strategy filter.
 * Pure function — no DB lookup, no network.
 */
export function evaluateEvent(ev: GammaEvent): FilterResult {
  // 1) target user (slug substring match)
  if (!ev.slug.toLowerCase().includes(config.discovery.targetUserSlug)) {
    return { pass: false, reason: 'wrong_user' };
  }

  // 2) must be open
  if (ev.closed) {
    return { pass: false, reason: 'closed' };
  }

  // 3) dates required
  if (!ev.startDate || !ev.endDate) {
    return { pass: false, reason: 'missing_dates' };
  }
  const days = durationDays(ev.startDate, ev.endDate);

  // 4) duration window
  if (
    days < config.discovery.marketMinDays ||
    days > config.discovery.marketMaxDays
  ) {
    return { pass: false, reason: 'duration_out_of_range', durationDays: days };
  }

  // 5) buckets must exist
  const buckets = extractBuckets(ev);
  if (buckets.length === 0) {
    return { pass: false, reason: 'no_buckets', durationDays: days };
  }

  // 6) freshness — if SOME bucket already trades above our snipe threshold,
  //    market is already discovered by someone else and we have no edge.
  const topPrice = Math.max(...buckets.map((b) => b.lastTradePrice));
  if (topPrice >= config.discovery.freshPriceThreshold) {
    return {
      pass: false,
      reason: 'already_traded',
      durationDays: days,
      topPrice,
    };
  }

  return { pass: true, reason: 'ok', durationDays: days, topPrice };
}

/**
 * Convert a passing GammaEvent into a MarketCandidate ready for snipe.
 * Caller must have verified `evaluateEvent(ev).pass === true` first.
 */
export function buildCandidate(
  ev: GammaEvent,
  source: 'poll' | 'ws',
  detectLatencyMs?: number
): MarketCandidate {
  return {
    slug: ev.slug,
    question: ev.title ?? null,
    startTs: ev.startDate!,
    endTs: ev.endDate!,
    durationDays: durationDays(ev.startDate!, ev.endDate!),
    negRisk: Boolean(ev.negRisk),
    buckets: extractBuckets(ev),
    detectedAt: new Date().toISOString(),
    source,
    detectLatencyMs,
  };
}
