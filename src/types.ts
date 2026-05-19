/**
 * types.ts — shared domain types.
 *
 * Keep this file tiny and dependency-free so any module can import from it.
 */

/** Raw shape returned by Polymarket Gamma /events. */
export interface GammaMarket {
  groupItemTitle?: string;
  clobTokenIds?: string | string[];
  conditionId?: string;
  lastTradePrice?: number | string | null;
  outcomes?: string | string[];
  outcomePrices?: string | string[];
}

export interface GammaEvent {
  slug: string;
  title?: string;
  startDate?: string;
  endDate?: string;
  negRisk?: boolean;
  closed?: boolean;
  active?: boolean;
  markets?: GammaMarket[];
}

/** One outcome inside a market, normalized. */
export interface BucketCandidate {
  title: string;               // groupItemTitle, e.g. "200-219"
  tokenIdYes: string;          // clobTokenIds[0]
  tokenIdNo: string | null;    // clobTokenIds[1]
  conditionId: string | null;
  lastTradePrice: number;      // 0 if absent
}

/** A market that passed the target filter and is ready to snipe. */
export interface MarketCandidate {
  slug: string;
  question: string | null;
  startTs: string;
  endTs: string;
  durationDays: number;
  negRisk: boolean;
  buckets: BucketCandidate[];
  detectedAt: string;
  source: 'poll' | 'ws';
  /** ms from event-creation to our local detect — best-effort, may be undefined. */
  detectLatencyMs?: number;
}
