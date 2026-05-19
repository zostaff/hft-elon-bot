/**
 * warmup.ts — keep critical HTTP paths hot.
 *
 * The dominant cost on the first live order is TLS handshake + TCP setup
 * (~30-80 ms). If we make a cheap GET right after boot — and keep the pool
 * alive with a periodic keepalive ping — every subsequent POST reuses the
 * established connection and saves that one-shot.
 *
 * Three independent warm targets:
 *   1. Gamma REST  (https://gamma-api.polymarket.com)  → undici Pool, used
 *      by poller & enrichment. Already hot in practice, but make boot
 *      deterministic.
 *   2. CLOB REST   (https://clob.polymarket.com)       → used by every live
 *      order POST. THIS IS THE EXPENSIVE ONE.
 *   3. viem/EIP-712 JIT → first signing call has ~5-10 ms JIT overhead;
 *      a dry sign on boot pays it off where it doesn't matter.
 *
 * In paper mode we still warm Gamma (it's used for discovery), but skip CLOB
 * and signing since they require creds.
 */

import { performance } from 'node:perf_hooks';
import { request } from 'undici';
import { logger } from './logger.js';
import { config } from '../config.js';
import { fetchTweetEvents } from './gamma.js';
import { getClobClient } from './clob.js';

const log = logger.child({ mod: 'warmup' });

const KEEPALIVE_INTERVAL_MS = 60_000; // every 60s, well under common idle timeouts

interface WarmupResult {
  gammaOk: boolean;
  gammaMs: number;
  clobOk: boolean;
  clobMs: number | null;
  signOk: boolean;
  signMs: number | null;
}

/** Send a single cheap GET to clob.polymarket.com to establish HTTP/TLS. */
async function warmClobConnection(): Promise<{ ok: boolean; ms: number }> {
  const t0 = performance.now();
  try {
    // /time is the cheapest authenticated-free endpoint.
    const { statusCode, body } = await request(`${config.clobHost}/time`, {
      method: 'GET',
      headersTimeout: 3_000,
      bodyTimeout: 3_000,
    });
    await body.dump();
    const ok = statusCode >= 200 && statusCode < 500; // any non-network ok
    return { ok, ms: Math.round(performance.now() - t0) };
  } catch (err) {
    log.warn({ err: (err as Error).message }, 'CLOB warmup GET failed');
    return { ok: false, ms: Math.round(performance.now() - t0) };
  }
}

/** Touch the SDK signer once so viem JIT-compiles the EIP-712 hot paths. */
async function warmSigner(): Promise<{ ok: boolean; ms: number | null }> {
  // Only meaningful in live mode when creds + private key are configured.
  if (config.tradeMode !== 'live') return { ok: true, ms: null };
  const t0 = performance.now();
  try {
    const client = await getClobClient();
    // Some SDK versions expose `getServerTime()` or `getAddress()`. Both are
    // safe to call repeatedly. We don't actually need the result — we need
    // viem's signing pipeline warm. A getter that hits a signed-but-non-mutating
    // path is ideal; fallback to a no-op if not present.
    const c = client as unknown as Record<string, unknown>;
    const fn =
      (c.getServerTime as unknown) ??
      (c.getAddress as unknown) ??
      (c.getApiKeys as unknown);
    if (typeof fn === 'function') {
      await (fn as () => Promise<unknown>).call(client);
    }
    return { ok: true, ms: Math.round(performance.now() - t0) };
  } catch (err) {
    log.warn({ err: (err as Error).message }, 'signer warmup failed (non-fatal)');
    return { ok: false, ms: Math.round(performance.now() - t0) };
  }
}

/** Top-level warmup: do all three. Safe to call multiple times. */
export async function warmupOnce(): Promise<WarmupResult> {
  log.info({ mode: config.tradeMode }, 'warmup starting');

  // 1) Gamma — same pool the poller uses
  const tGamma = performance.now();
  let gammaOk = false;
  try {
    await fetchTweetEvents({ timeoutMs: 3_000 });
    gammaOk = true;
  } catch (err) {
    log.warn({ err: (err as Error).message }, 'gamma warmup failed');
  }
  const gammaMs = Math.round(performance.now() - tGamma);

  // 2) CLOB — same host the live executor will POST to
  const { ok: clobOk, ms: clobMs } = await warmClobConnection();

  // 3) viem/SDK signer — only live mode
  const { ok: signOk, ms: signMs } = await warmSigner();

  const result: WarmupResult = {
    gammaOk,
    gammaMs,
    clobOk,
    clobMs,
    signOk,
    signMs,
  };
  log.info(result, 'warmup done');
  return result;
}

let keepaliveTimer: NodeJS.Timeout | null = null;

/** Start a low-frequency keepalive ping so idle connections don't die. */
export function startKeepalive(): void {
  if (keepaliveTimer) return;
  keepaliveTimer = setInterval(() => {
    void warmClobConnection().then((r) => {
      if (!r.ok) {
        log.debug({ ms: r.ms }, 'keepalive ping non-2xx (informational)');
      }
    });
  }, KEEPALIVE_INTERVAL_MS);
  // Allow node to exit if this is the only timer left
  keepaliveTimer.unref();
  log.info({ intervalMs: KEEPALIVE_INTERVAL_MS }, 'keepalive started');
}

export function stopKeepalive(): void {
  if (keepaliveTimer) {
    clearInterval(keepaliveTimer);
    keepaliveTimer = null;
  }
}
