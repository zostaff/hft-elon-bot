/**
 * discovery/index.ts — DiscoveryManager.
 *
 * Composes Poller (always-on safety net) and WsWatcher (fast-path).
 * Deduplicates `newMarket` events so downstream consumers see each market
 * exactly once, regardless of which channel detected it first.
 */

import { EventEmitter } from 'node:events';
import { logger } from '../lib/logger.js';
import { config } from '../config.js';
import { Poller } from './poller.js';
import { WsWatcher } from './ws-watcher.js';
import {
  recordMarket,
  recordOutcome,
  listOpenMarkets,
  logEvent,
} from '../data/db.js';
import type { MarketCandidate } from '../types.js';

const log = logger.child({ mod: 'discovery' });

export interface DiscoveryEvents {
  newMarket: (candidate: MarketCandidate) => void;
}

export declare interface DiscoveryManager {
  on<K extends keyof DiscoveryEvents>(
    event: K,
    listener: DiscoveryEvents[K]
  ): this;
  emit<K extends keyof DiscoveryEvents>(
    event: K,
    ...args: Parameters<DiscoveryEvents[K]>
  ): boolean;
}

export class DiscoveryManager extends EventEmitter {
  private poller: Poller;
  private ws: WsWatcher | null;
  private dispatched = new Set<string>();
  private statsTimer: NodeJS.Timeout | null = null;

  constructor() {
    super();
    this.poller = new Poller();
    this.ws = config.discovery.wsEnabled ? new WsWatcher() : null;

    this.poller.on('newMarket', (c) => this.handle(c));
    this.ws?.on('newMarket', (c) => this.handle(c));

    // Defensive: EventEmitter without an `error` listener will crash the
    // process. Poller no longer emits error, but ws-watcher does on socket
    // failure; just log and let the auto-reconnect path handle it.
    this.poller.on('error', (err) =>
      log.debug({ err: err.message }, 'poller error (handled)')
    );
    this.ws?.on('error', (err) =>
      log.debug({ err: err.message }, 'ws error (handled)')
    );
  }

  start(): void {
    // Seed dedup set from DB so a bot restart doesn't re-emit known markets
    const existing = listOpenMarkets().map((m) => m.slug);
    for (const slug of existing) this.dispatched.add(slug);
    this.poller.seedSeen(existing);

    log.info(
      {
        seeded: existing.length,
        wsEnabled: Boolean(this.ws),
      },
      'discovery starting'
    );

    this.poller.start();
    this.ws?.start();

    // Periodic stats so we can see liveness without DEBUG noise
    this.statsTimer = setInterval(() => this.logStats(), 60_000);
  }

  stop(): void {
    if (this.statsTimer) {
      clearInterval(this.statsTimer);
      this.statsTimer = null;
    }
    this.poller.stop();
    this.ws?.stop();
    log.info('discovery stopped');
  }

  private handle(candidate: MarketCandidate): void {
    if (this.dispatched.has(candidate.slug)) {
      log.debug(
        { slug: candidate.slug, source: candidate.source },
        'dedup: already dispatched'
      );
      return;
    }
    this.dispatched.add(candidate.slug);

    // Persist market + outcomes (idempotent via INSERT OR IGNORE)
    const isNew = recordMarket({
      slug: candidate.slug,
      question: candidate.question,
      negRisk: candidate.negRisk,
      startTs: candidate.startTs,
      endTs: candidate.endTs,
      durationDays: candidate.durationDays,
    });
    for (const b of candidate.buckets) {
      recordOutcome({
        marketSlug: candidate.slug,
        title: b.title,
        tokenIdYes: b.tokenIdYes,
        tokenIdNo: b.tokenIdNo,
        tickSize: null,        // populated later via clob getMarketInfo
        minOrderSize: null,
      });
    }

    logEvent('info', 'market_detected', {
      slug: candidate.slug,
      source: candidate.source,
      buckets: candidate.buckets.length,
      detectLatencyMs: candidate.detectLatencyMs ?? null,
      persisted: isNew ? 'new' : 'already_in_db',
    });

    log.info(
      {
        slug: candidate.slug,
        source: candidate.source,
        buckets: candidate.buckets.length,
        negRisk: candidate.negRisk,
        durationDays: candidate.durationDays.toFixed(2),
        latencyMs: candidate.detectLatencyMs ?? null,
        persisted: isNew ? 'new' : 'already_in_db',
      },
      '✅ DISCOVERY: candidate ready for snipe'
    );

    this.emit('newMarket', candidate);
  }

  private logStats(): void {
    const p = this.poller.getStats();
    const w = this.ws?.getStats();
    log.info(
      {
        poller: p,
        ws: w ?? 'disabled',
        dispatched: this.dispatched.size,
      },
      'discovery stats'
    );
  }
}
