/**
 * live.ts — live-mode executor (CLOB V2).
 *
 * For each LadderOrder in the batch:
 *   1. fire createAndPostOrder in parallel (Promise.all)
 *   2. persist outcome to DB (order_id, status, latency)
 *   3. report kill-switch (success/fail)
 *
 * Tick alignment: caller is responsible for passing tickSize. If the price
 * doesn't fit the grid, the SDK will reject — we'd rather align upstream.
 *
 * Failure isolation: one rejected order does NOT abort the batch.
 */

import { performance } from 'node:perf_hooks';
import { logger } from '../lib/logger.js';
import { insertOrder, ackOrder } from '../data/db.js';
import { placeLiveOrder } from '../lib/clob.js';
import { killSwitch } from '../risk/kill-switch.js';
import type { LadderOrder } from '../trader/ladder.js';

const log = logger.child({ mod: 'live' });

export interface LiveResult {
  ok: boolean;
  orderId: number;            // DB row id (always set)
  clobOrderId: string | null; // remote order id from CLOB
  latencyMs: number;
  error?: string;
}

export interface LiveBatchOptions {
  /** Same tickSize per market — caller has already aligned ladder prices. */
  tickSize: string;
}

export async function placeLiveBatch(
  marketSlug: string,
  orders: LadderOrder[],
  opts: LiveBatchOptions
): Promise<LiveResult[]> {
  if (killSwitch.isTripped()) {
    log.error(
      { reason: killSwitch.trippedReasonText(), slug: marketSlug },
      '🛑 placeLiveBatch refused — kill switch tripped'
    );
    return orders.map(() => ({
      ok: false,
      orderId: -1,
      clobOrderId: null,
      latencyMs: 0,
      error: 'kill_switch_tripped',
    }));
  }

  log.info(
    {
      slug: marketSlug,
      count: orders.length,
      tickSize: opts.tickSize,
    },
    'placeLiveBatch dispatching'
  );

  const batchT0 = performance.now();
  const results = await Promise.all(
    orders.map((o) => placeOne(marketSlug, o, opts.tickSize))
  );
  const batchMs = Math.round(performance.now() - batchT0);

  const ok = results.filter((r) => r.ok).length;
  log.info(
    {
      slug: marketSlug,
      ok,
      failed: results.length - ok,
      batchMs,
      meanLatency: Math.round(
        results.reduce((a, r) => a + r.latencyMs, 0) / Math.max(1, results.length)
      ),
    },
    'placeLiveBatch complete'
  );

  return results;
}

async function placeOne(
  marketSlug: string,
  o: LadderOrder,
  tickSize: string
): Promise<LiveResult> {
  // 1) Persist the intent FIRST so we have a row id even if the POST fails.
  const dbId = insertOrder({
    marketSlug,
    outcomeTitle: o.bucketTitle,
    tokenId: o.tokenId,
    mode: 'live',
    side: 'BUY',
    price: o.price,
    sizeUsd: o.sizeUsd,
  });

  // 2) Dispatch
  const resp = await placeLiveOrder({
    tokenId: o.tokenId,
    price: o.price,
    sizeShares: o.sizeShares,
    tickSize,
    side: 'BUY',
  });

  // 3) Ack DB + kill-switch
  if (resp.ok && resp.orderId) {
    ackOrder({
      id: dbId,
      status: 'placed',
      clobOrderId: resp.orderId,
      errorMsg: null,
      latencyMs: resp.latencyMs,
    });
    killSwitch.recordLiveOrder(true);
    log.debug(
      {
        dbId,
        clobId: resp.orderId,
        bucket: o.bucketTitle,
        price: o.price,
        sizeShares: o.sizeShares,
        latencyMs: resp.latencyMs,
      },
      'live order placed'
    );
    return {
      ok: true,
      orderId: dbId,
      clobOrderId: resp.orderId,
      latencyMs: resp.latencyMs,
    };
  }

  ackOrder({
    id: dbId,
    status: 'rejected',
    clobOrderId: resp.orderId,
    errorMsg: resp.errorMsg,
    latencyMs: resp.latencyMs,
  });
  killSwitch.recordLiveOrder(false, resp.errorMsg);
  log.warn(
    {
      dbId,
      bucket: o.bucketTitle,
      price: o.price,
      sizeShares: o.sizeShares,
      err: resp.errorMsg,
      latencyMs: resp.latencyMs,
    },
    'live order rejected'
  );
  return {
    ok: false,
    orderId: dbId,
    clobOrderId: resp.orderId,
    latencyMs: resp.latencyMs,
    error: resp.errorMsg ?? undefined,
  };
}
