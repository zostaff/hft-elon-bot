/**
 * ws-watcher.ts — Polymarket CLOB Market-channel WebSocket fast-path.
 *
 * Subscribes with `custom_feature_enabled: true` to receive `new_market`
 * events (~0ms latency vs 0-1000ms for polling).
 *
 * The new_market payload has minimal fields (question, assets_ids, outcomes),
 * so we enrich via Gamma /events?slug= to get clobTokenIds + dates + negRisk.
 *
 * Robustness:
 *   - Auto-reconnect with exponential backoff (1s → 60s cap)
 *   - PING every 10s, reconnect if no traffic for 30s
 *   - Polling layer is the safety net — if WS dies, we still detect via poll
 */

import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { logger } from '../lib/logger.js';
import { config } from '../config.js';
import { fetchEventBySlug } from '../lib/gamma.js';
import { evaluateEvent, buildCandidate } from './filter.js';
import type { MarketCandidate } from '../types.js';

const log = logger.child({ mod: 'ws' });

const WS_URL = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';
const PING_INTERVAL_MS = 10_000;
const STALE_TIMEOUT_MS = 30_000;
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 60_000;

// Subscription requires non-empty assets_ids per docs, even though new_market
// fires regardless. Send a placeholder.
const SUBSCRIBE_MSG = JSON.stringify({
  type: 'market',
  assets_ids: ['0'],
  custom_feature_enabled: true,
});

interface NewMarketWsEvent {
  event_type: 'new_market';
  question?: string;
  assets_ids?: string[];
  outcomes?: string[];
  slug?: string;        // not documented, but check just in case
  condition_id?: string;
}

export interface WsWatcherEvents {
  newMarket: (candidate: MarketCandidate) => void;
  connected: () => void;
  disconnected: (reason: string) => void;
  error: (err: Error) => void;
}

export declare interface WsWatcher {
  on<K extends keyof WsWatcherEvents>(event: K, listener: WsWatcherEvents[K]): this;
  emit<K extends keyof WsWatcherEvents>(
    event: K,
    ...args: Parameters<WsWatcherEvents[K]>
  ): boolean;
}

export class WsWatcher extends EventEmitter {
  private ws: WebSocket | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private staleTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectDelayMs = RECONNECT_BASE_MS;
  private running = false;
  private connectCount = 0;
  private msgCount = 0;
  private newMarketCount = 0;

  start(): void {
    if (this.running) return;
    this.running = true;
    this.connect();
  }

  stop(): void {
    this.running = false;
    this.clearTimers();
    if (this.ws) {
      try {
        this.ws.close(1000, 'shutdown');
      } catch {
        /* ignore */
      }
      this.ws = null;
    }
    log.info(
      { msgs: this.msgCount, newMarkets: this.newMarketCount },
      'ws stopped'
    );
  }

  private connect(): void {
    if (!this.running) return;
    this.connectCount += 1;
    log.info({ url: WS_URL, attempt: this.connectCount }, 'ws connecting');

    const ws = new WebSocket(WS_URL);
    this.ws = ws;

    ws.on('open', () => {
      log.info('ws connected');
      this.reconnectDelayMs = RECONNECT_BASE_MS;
      try {
        ws.send(SUBSCRIBE_MSG);
        log.debug('ws subscribe sent');
      } catch (e) {
        log.warn({ err: (e as Error).message }, 'ws subscribe failed');
      }
      this.armPing();
      this.armStaleTimer();
      this.emit('connected');
    });

    ws.on('message', (raw) => {
      this.msgCount += 1;
      this.armStaleTimer();

      const text = raw.toString();
      // Server may send "PONG" as a plain string in response to our PING
      if (text === 'PONG') {
        log.trace('ws pong');
        return;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        log.debug({ preview: text.slice(0, 120) }, 'ws non-json message');
        return;
      }

      // Polymarket may batch events as arrays
      const events = Array.isArray(parsed) ? parsed : [parsed];
      for (const e of events) {
        void this.handleEvent(e as Record<string, unknown>);
      }
    });

    ws.on('close', (code, reason) => {
      log.warn({ code, reason: reason.toString() }, 'ws closed');
      this.clearTimers();
      this.ws = null;
      this.emit('disconnected', `code=${code}`);
      this.scheduleReconnect();
    });

    ws.on('error', (err) => {
      log.warn({ err: err.message }, 'ws error');
      this.emit('error', err);
      // close handler will trigger reconnect
    });
  }

  private async handleEvent(ev: Record<string, unknown>): Promise<void> {
    const eventType = ev.event_type;
    if (eventType !== 'new_market') {
      log.trace({ event_type: eventType }, 'ws ignored event');
      return;
    }

    this.newMarketCount += 1;
    const data = ev as unknown as NewMarketWsEvent;
    const slug = data.slug;

    // FAST PATH: pre-filter by slug substring BEFORE enrichment. Polymarket
    // emits hundreds of crypto-5m markets per hour; without this guard we'd
    // hit Gamma for every one of them.
    const target = config.discovery.targetUserSlug;
    if (!slug || !slug.toLowerCase().includes(target)) {
      log.debug(
        { slug: slug ?? null, question: data.question },
        'ws new_market: not target user, skipping enrichment'
      );
      return;
    }

    log.info(
      {
        slug,
        question: data.question,
        outcomes: data.outcomes?.length,
        assets: data.assets_ids?.length,
      },
      '⚡ ws: TARGET new_market event'
    );

    const t0 = performance.now();
    try {
      const enriched = await fetchEventBySlug(slug);
      if (!enriched) {
        log.warn({ slug }, 'ws new_market: gamma enrichment returned null');
        return;
      }
      const verdict = evaluateEvent(enriched);
      if (!verdict.pass) {
        log.debug({ slug, ...verdict }, 'ws new_market rejected by filter');
        return;
      }
      const latency = Math.round(performance.now() - t0);
      const candidate = buildCandidate(enriched, 'ws', latency);
      log.info(
        {
          slug: candidate.slug,
          duration: candidate.durationDays.toFixed(2),
          buckets: candidate.buckets.length,
          enrichMs: latency,
        },
        '🎯 ws: target market'
      );
      this.emit('newMarket', candidate);
    } catch (err) {
      log.warn(
        { slug, err: (err as Error).message },
        'ws enrichment failed — poller will catch it'
      );
    }
  }

  private armPing(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        try {
          this.ws.send('PING');
          log.trace('ws ping');
        } catch (e) {
          log.debug({ err: (e as Error).message }, 'ws ping send failed');
        }
      }
    }, PING_INTERVAL_MS);
  }

  private armStaleTimer(): void {
    if (this.staleTimer) clearTimeout(this.staleTimer);
    this.staleTimer = setTimeout(() => {
      log.warn({ stale_ms: STALE_TIMEOUT_MS }, 'ws stale, forcing reconnect');
      try {
        this.ws?.terminate();
      } catch {
        /* ignore */
      }
    }, STALE_TIMEOUT_MS);
  }

  private clearTimers(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    if (this.staleTimer) {
      clearTimeout(this.staleTimer);
      this.staleTimer = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private scheduleReconnect(): void {
    if (!this.running) return;
    const delay = this.reconnectDelayMs;
    this.reconnectDelayMs = Math.min(
      this.reconnectDelayMs * 2,
      RECONNECT_MAX_MS
    );
    log.info({ delayMs: delay }, 'ws reconnect scheduled');
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  getStats(): { connects: number; msgs: number; newMarkets: number } {
    return {
      connects: this.connectCount,
      msgs: this.msgCount,
      newMarkets: this.newMarketCount,
    };
  }
}
