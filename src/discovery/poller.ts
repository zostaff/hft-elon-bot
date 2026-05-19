/**
 * poller.ts — Gamma polling discoverer.
 *
 * Fires `newMarket` event whenever a target market appears in /events that
 * we haven't seen before. The "seen" set is in-memory; the DiscoveryManager
 * applies cross-source dedup.
 */

import { EventEmitter } from 'node:events';
import { logger } from '../lib/logger.js';
import { fetchTweetEvents } from '../lib/gamma.js';
import { config } from '../config.js';
import { evaluateEvent, buildCandidate } from './filter.js';
import type { MarketCandidate } from '../types.js';

const log = logger.child({ mod: 'poller' });

export interface PollerEvents {
  newMarket: (candidate: MarketCandidate) => void;
  error: (err: Error) => void;
}

export declare interface Poller {
  on<K extends keyof PollerEvents>(event: K, listener: PollerEvents[K]): this;
  emit<K extends keyof PollerEvents>(
    event: K,
    ...args: Parameters<PollerEvents[K]>
  ): boolean;
}

export class Poller extends EventEmitter {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private seen = new Set<string>();
  private consecutiveErrors = 0;
  private pollCount = 0;

  constructor(private readonly intervalMs: number = config.discovery.pollIntervalMs) {
    super();
  }

  /**
   * Seed `seen` from existing DB markets so we don't re-emit on restart.
   * Pass the set of known slugs from caller.
   */
  seedSeen(slugs: Iterable<string>): void {
    for (const s of slugs) this.seen.add(s);
    log.info({ seeded: this.seen.size }, 'poller seeded from db');
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    log.info({ intervalMs: this.intervalMs }, 'poller starting');
    // First tick immediately, then schedule
    void this.tick();
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    log.info({ polls: this.pollCount }, 'poller stopped');
  }

  private schedule(): void {
    if (!this.running) return;
    this.timer = setTimeout(() => void this.tick(), this.intervalMs);
  }

  private async tick(): Promise<void> {
    this.pollCount += 1;
    try {
      const events = await fetchTweetEvents();
      this.consecutiveErrors = 0;

      // First poll: just seed `seen` without emitting (avoids "all existing
      // markets are 'new'" stampede on startup).
      const firstPoll = this.pollCount === 1 && this.seen.size === 0;

      for (const ev of events) {
        if (this.seen.has(ev.slug)) continue;

        const verdict = evaluateEvent(ev);
        this.seen.add(ev.slug); // record regardless to avoid re-checking

        if (firstPoll) {
          log.debug(
            { slug: ev.slug, ...verdict },
            'poller seed-evaluating existing event'
          );
          continue;
        }

        if (!verdict.pass) {
          log.debug({ slug: ev.slug, ...verdict }, 'event rejected by filter');
          continue;
        }

        const candidate = buildCandidate(ev, 'poll');
        log.info(
          {
            slug: candidate.slug,
            duration: candidate.durationDays.toFixed(2),
            buckets: candidate.buckets.length,
            negRisk: candidate.negRisk,
          },
          '🎯 poller: new target market'
        );
        this.emit('newMarket', candidate);
      }

      if (firstPoll) {
        log.info(
          { tracked: this.seen.size },
          'poller seeded — future polls will emit truly-new markets'
        );
      }
    } catch (err) {
      this.consecutiveErrors += 1;
      log.warn(
        {
          err: (err as Error).message,
          consecutive: this.consecutiveErrors,
        },
        'poller tick failed (will retry next interval)'
      );
      // Intentionally do NOT emit('error') — unhandled error events kill the
      // process. Transient Gamma/undici errors must not bring down the bot.
      // The consecutive counter is exposed via getStats() for monitoring.
    } finally {
      this.schedule();
    }
  }

  getStats(): { polls: number; seen: number; errors: number } {
    return {
      polls: this.pollCount,
      seen: this.seen.size,
      errors: this.consecutiveErrors,
    };
  }
}
