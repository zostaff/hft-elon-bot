/**
 * paper.ts — paper-mode executor.
 *
 * Records each order as `placed` instantly, no network. This is what runs
 * before live keys are wired up. Fill simulation (did our $0.015 bid ever
 * actually fill?) is deferred — orders will simply remain `placed` until
 * we add a resolution-time fill simulator in a later phase.
 */

import { performance } from 'node:perf_hooks';
import { logger } from '../lib/logger.js';
import { insertOrder, ackOrder } from '../data/db.js';
import type { LadderOrder } from '../trader/ladder.js';

const log = logger.child({ mod: 'paper' });

export interface PaperResult {
  ok: boolean;
  orderId: number;
  latencyMs: number;
  error?: string;
}

/**
 * "Place" a paper order — write to DB, mark placed, no network.
 *
 * Returns the synthetic latency (microseconds for sqlite I/O) so the same
 * code path produces comparable metrics in paper vs live.
 */
export function placePaperOrder(
  marketSlug: string,
  o: LadderOrder
): PaperResult {
  const t0 = performance.now();
  let orderId = -1;
  try {
    orderId = insertOrder({
      marketSlug,
      outcomeTitle: o.bucketTitle,
      tokenId: o.tokenId,
      mode: 'paper',
      side: 'BUY',
      price: o.price,
      sizeUsd: o.sizeUsd,
    });

    const latencyMs = Math.round((performance.now() - t0) * 1000) / 1000;
    ackOrder({
      id: orderId,
      status: 'placed',
      clobOrderId: `paper-${orderId}`,
      errorMsg: null,
      latencyMs: Math.round(latencyMs),
    });

    log.debug(
      {
        orderId,
        slug: marketSlug,
        bucket: o.bucketTitle,
        price: o.price,
        sizeUsd: o.sizeUsd,
        latencyMs,
      },
      'paper order placed'
    );
    return { ok: true, orderId, latencyMs };
  } catch (err) {
    const latencyMs = Math.round((performance.now() - t0) * 1000) / 1000;
    log.error(
      { err: (err as Error).message, slug: marketSlug, bucket: o.bucketTitle },
      'paper order failed (db write error)'
    );
    if (orderId > 0) {
      try {
        ackOrder({
          id: orderId,
          status: 'error',
          clobOrderId: null,
          errorMsg: (err as Error).message,
          latencyMs: Math.round(latencyMs),
        });
      } catch {
        /* ignore secondary failure */
      }
    }
    return {
      ok: false,
      orderId,
      latencyMs,
      error: (err as Error).message,
    };
  }
}

/** Batch interface so caller doesn't care about paper vs live. */
export function placePaperBatch(
  marketSlug: string,
  orders: LadderOrder[]
): PaperResult[] {
  return orders.map((o) => placePaperOrder(marketSlug, o));
}
