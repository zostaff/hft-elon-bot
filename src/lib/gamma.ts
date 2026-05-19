/**
 * gamma.ts — minimal Polymarket Gamma REST client.
 *
 * Uses undici Pool for persistent HTTP/2-like keep-alive. Shared across
 * poller and any one-off lookups.
 */

import { Pool } from 'undici';
import { config } from '../config.js';
import { logger } from './logger.js';
import type { GammaEvent, GammaMarket, BucketCandidate } from '../types.js';

const log = logger.child({ mod: 'gamma' });

// Pool with persistent connections — kept warm so cold-start TLS doesn't bite.
const gammaPool = new Pool(config.gammaHost, {
  connections: 4,
  pipelining: 1,
  keepAliveTimeout: 60_000,
  keepAliveMaxTimeout: 600_000,
});

const TWEET_MARKETS_TAG_ID = 972;

interface FetchOpts {
  /** Soft timeout in ms (headers + body). */
  timeoutMs?: number;
}

/**
 * Fetch the live Tweet-Markets events list. Caller filters.
 *
 * @throws on HTTP != 200 or network error
 */
export async function fetchTweetEvents(opts: FetchOpts = {}): Promise<GammaEvent[]> {
  const timeoutMs = opts.timeoutMs ?? 2_500;
  const path =
    `/events?tag_id=${TWEET_MARKETS_TAG_ID}` +
    `&closed=false&limit=30&order=startDate&ascending=false`;

  const t0 = performance.now();
  const { statusCode, body } = await gammaPool.request({
    path,
    method: 'GET',
    headersTimeout: timeoutMs,
    bodyTimeout: timeoutMs,
  });

  if (statusCode !== 200) {
    // Drain body to avoid socket leak
    await body.dump();
    throw new Error(`gamma /events HTTP ${statusCode}`);
  }

  const data = (await body.json()) as GammaEvent[];
  log.debug(
    { ms: Math.round(performance.now() - t0), total: data.length },
    'gamma /events ok'
  );
  return data;
}

/**
 * Fetch a single event by slug (used for enrichment when WS gives us only
 * a slug and we need clobTokenIds).
 */
export async function fetchEventBySlug(
  slug: string,
  opts: FetchOpts = {}
): Promise<GammaEvent | null> {
  const timeoutMs = opts.timeoutMs ?? 2_500;
  const path = `/events?slug=${encodeURIComponent(slug)}`;

  const { statusCode, body } = await gammaPool.request({
    path,
    method: 'GET',
    headersTimeout: timeoutMs,
    bodyTimeout: timeoutMs,
  });

  if (statusCode !== 200) {
    await body.dump();
    throw new Error(`gamma /events?slug HTTP ${statusCode}`);
  }

  const data = (await body.json()) as GammaEvent[];
  return data.length > 0 ? data[0]! : null;
}

/** Parse clobTokenIds which can come as JSON string or array. */
function parseClobTokens(raw: string | string[] | undefined): string[] {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Extract per-bucket info from a Gamma event. Skips bucket if no tokens. */
export function extractBuckets(ev: GammaEvent): BucketCandidate[] {
  const out: BucketCandidate[] = [];
  for (const m of ev.markets ?? []) {
    const title = m.groupItemTitle;
    if (!title) continue;
    const tokens = parseClobTokens(m.clobTokenIds);
    if (tokens.length === 0) continue;
    const [tokenIdYes, tokenIdNo] = tokens;
    if (!tokenIdYes) continue;
    out.push({
      title,
      tokenIdYes,
      tokenIdNo: tokenIdNo ?? null,
      conditionId: m.conditionId ?? null,
      lastTradePrice: parseFloat(String(m.lastTradePrice ?? 0)) || 0,
    });
  }
  return out;
}

export function durationDays(startDate: string, endDate: string): number {
  return (
    (new Date(endDate).getTime() - new Date(startDate).getTime()) /
    (1000 * 60 * 60 * 24)
  );
}

export async function closeGamma(): Promise<void> {
  await gammaPool.close();
}
