/**
 * clob.ts — single CLOB V2 client.
 *
 * Two-phase auth:
 *   L1: wallet (viem) — only needed to derive API key (`createOrDeriveApiKey`)
 *   L2: HMAC creds   — used for every order/cancel/account call
 *
 * Wraps lazy init so the client is built exactly once per process.
 * Throws if TRADE_MODE=live but creds aren't filled in.
 *
 * SDK reference: https://github.com/Polymarket/clob-client-v2
 */

import {
  ApiKeyCreds,
  Chain,
  ClobClient,
  OrderType,
  Side,
  type TickSize,
} from '@polymarket/clob-client-v2';
import { createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { polygon } from 'viem/chains';
import { config } from '../config.js';
import { logger } from './logger.js';

const log = logger.child({ mod: 'clob' });

let clientSingleton: ClobClient | null = null;
let initPromise: Promise<ClobClient> | null = null;

function buildSigner() {
  const pk = config.credentials.walletPrivateKey;
  if (!pk) {
    throw new Error(
      'CLOB init: WALLET_PRIVATE_KEY is not set. Required for live mode.'
    );
  }
  const normalized = (pk.startsWith('0x') ? pk : `0x${pk}`) as `0x${string}`;
  const account = privateKeyToAccount(normalized);
  const walletClient = createWalletClient({
    account,
    chain: polygon,
    transport: http(config.polygonRpcUrl),
  });
  return { account, walletClient };
}

function credsFromEnv(): ApiKeyCreds | null {
  const { clobApiKey, clobSecret, clobPassPhrase } = config.credentials;
  if (!clobApiKey || !clobSecret || !clobPassPhrase) return null;
  return {
    key: clobApiKey,
    secret: clobSecret,
    passphrase: clobPassPhrase,
  };
}

/**
 * Init or return the cached fully-authenticated CLOB client.
 * Safe to call concurrently — initPromise dedupes.
 */
export async function getClobClient(): Promise<ClobClient> {
  if (clientSingleton) return clientSingleton;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    const { walletClient, account } = buildSigner();
    const creds = credsFromEnv();
    if (!creds) {
      throw new Error(
        'CLOB init: CLOB_API_KEY/SECRET/PASS_PHRASE not set. ' +
          'Run `npm run setup-creds` to derive them.'
      );
    }
    const client = new ClobClient({
      host: config.clobHost,
      chain: Chain.POLYGON,
      signer: walletClient,
      creds,
    });
    log.info(
      {
        wallet: account.address,
        proxy: config.credentials.polymarketProxyAddress,
        host: config.clobHost,
        chain: 'polygon',
      },
      'CLOB V2 client ready'
    );
    clientSingleton = client;
    return client;
  })();

  try {
    return await initPromise;
  } finally {
    initPromise = null;
  }
}

/**
 * Stand-alone variant used by setup-creds: gives back an L1-only client
 * so we can call `createOrDeriveApiKey()` and then print the L2 creds.
 */
export async function getL1Client(): Promise<{
  client: ClobClient;
  walletAddress: string;
}> {
  const { walletClient, account } = buildSigner();
  const client = new ClobClient({
    host: config.clobHost,
    chain: Chain.POLYGON,
    signer: walletClient,
  });
  return { client, walletAddress: account.address };
}

/** Per-market info: tick size + minimum order size + neg-risk flag. */
export interface ClobMarketInfo {
  conditionId: string;
  tickSize: '0.01' | '0.001' | '0.0001' | string;
  minOrderSize: number;
  negRisk: boolean;
  enableOrderBook: boolean;
}

/**
 * Best-effort tickSize/mos lookup. CLOB V2 exposes `getClobMarketInfo`.
 * If the call shape differs across SDK versions, we fall back to a
 * conservative default.
 */
export async function fetchMarketInfo(
  conditionId: string
): Promise<ClobMarketInfo> {
  const client = await getClobClient();
  // The SDK method has historically been named getClobMarketInfo /
  // getMarketTradeEvents / getMarket. We probe gracefully.
  const c = client as unknown as Record<string, unknown>;
  const fn =
    (c.getClobMarketInfo as unknown) ??
    (c.getMarket as unknown) ??
    (c.getMarketInfo as unknown);
  if (typeof fn !== 'function') {
    log.warn(
      'CLOB SDK has no getClobMarketInfo/getMarket — defaulting tick=0.01 mos=5'
    );
    return {
      conditionId,
      tickSize: '0.01',
      minOrderSize: 5,
      negRisk: true,
      enableOrderBook: true,
    };
  }
  const raw = (await (fn as (id: string) => Promise<Record<string, unknown>>)(
    conditionId
  )) ?? {};

  // Be liberal in what we accept — different SDK versions name things
  // slightly differently.
  const tickRaw =
    (raw.minimum_tick_size as string | undefined) ??
    (raw.tick_size as string | undefined) ??
    (raw.tickSize as string | undefined) ??
    '0.01';
  const mosRaw =
    (raw.minimum_order_size as number | string | undefined) ??
    (raw.min_order_size as number | string | undefined) ??
    (raw.mos as number | string | undefined) ??
    5;
  const negRisk = Boolean(raw.neg_risk ?? raw.negRisk ?? false);

  return {
    conditionId,
    tickSize: String(tickRaw),
    minOrderSize: Number(mosRaw),
    negRisk,
    enableOrderBook: Boolean(raw.enable_order_book ?? raw.enableOrderBook ?? true),
  };
}

/** Validate/narrow a string to the SDK's TickSize union. */
function toTickSize(s: string): TickSize {
  if (s === '0.1' || s === '0.01' || s === '0.001' || s === '0.0001') return s;
  // Default to 0.01 (most common). Caller is responsible for re-aligning the
  // price if the actual market tick is different.
  return '0.01';
}

export interface LiveOrderArgs {
  tokenId: string;
  price: number;        // already tick-aligned
  sizeShares: number;
  tickSize: string;
  side: 'BUY' | 'SELL';
}

export interface LiveOrderResult {
  ok: boolean;
  orderId: string | null;
  errorMsg: string | null;
  latencyMs: number;
  raw?: unknown;
}

/**
 * Submit one resting limit order (GTC). Returns latency from call start
 * to ack receipt — that's our critical-path metric.
 */
export async function placeLiveOrder(args: LiveOrderArgs): Promise<LiveOrderResult> {
  const client = await getClobClient();
  const t0 = performance.now();
  try {
    const resp = await client.createAndPostOrder(
      {
        tokenID: args.tokenId,
        price: args.price,
        side: args.side === 'BUY' ? Side.BUY : Side.SELL,
        size: args.sizeShares,
      },
      { tickSize: toTickSize(args.tickSize) },
      OrderType.GTC
    );
    const latency = Math.round(performance.now() - t0);

    // SDK may return either { orderID } or { id } depending on version
    const r = resp as Record<string, unknown>;
    const orderId =
      (r.orderID as string | undefined) ??
      (r.orderId as string | undefined) ??
      (r.id as string | undefined) ??
      null;
    const error = (r.error as string | undefined) ?? null;

    if (error) {
      return { ok: false, orderId, errorMsg: error, latencyMs: latency, raw: resp };
    }
    return { ok: true, orderId, errorMsg: null, latencyMs: latency, raw: resp };
  } catch (err) {
    return {
      ok: false,
      orderId: null,
      errorMsg: (err as Error).message,
      latencyMs: Math.round(performance.now() - t0),
    };
  }
}

/** Align an arbitrary price to the market's tick grid (rounds DOWN for BUY). */
export function alignPriceDown(price: number, tickSize: string): number {
  const tick = Number(tickSize);
  if (!Number.isFinite(tick) || tick <= 0) return price;
  const ticks = Math.floor(price / tick);
  return Math.round(ticks * tick * 1e6) / 1e6;
}
