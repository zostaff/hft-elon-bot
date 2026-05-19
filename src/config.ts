/**
 * config.ts — environment loading + runtime validation via zod.
 *
 * Fails fast on startup with a clear error if anything required is missing
 * or malformed. Live-mode credentials are only required when TRADE_MODE=live.
 */

import 'dotenv/config';
import { z } from 'zod';

// ──────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────

const csvFloats = (raw: string): number[] =>
  raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const n = Number(s);
      if (!Number.isFinite(n)) throw new Error(`not a number: ${s}`);
      return n;
    });

const boolish = (raw: string | undefined, fallback: boolean): boolean => {
  if (raw === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
};

// ──────────────────────────────────────────────────────────────
// Schema
// ──────────────────────────────────────────────────────────────

const TradeMode = z.enum(['paper', 'live']);

const EnvSchema = z.object({
  TRADE_MODE: TradeMode.default('paper'),
  LOG_LEVEL: z
    .enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal'])
    .default('info'),
  LOG_PRETTY: z.string().optional(),

  DB_PATH: z.string().default('./data/bot.db'),

  CLOB_HOST: z.string().url().default('https://clob.polymarket.com'),
  GAMMA_HOST: z.string().url().default('https://gamma-api.polymarket.com'),
  POLYGON_RPC_URL: z.string().url().default('https://polygon-rpc.com'),

  // Live-mode credentials (optional in paper mode; checked below)
  WALLET_PRIVATE_KEY: z.string().optional(),
  CLOB_API_KEY: z.string().optional(),
  CLOB_SECRET: z.string().optional(),
  CLOB_PASS_PHRASE: z.string().optional(),
  POLYMARKET_PROXY_ADDRESS: z.string().optional(),

  BANKROLL_USD: z.coerce.number().positive().default(200),
  LADDER_PRICES: z.string().default('0.015,0.025,0.035'),
  LADDER_SIZE_SPLIT: z.string().default('0.4,0.3,0.3'),
  MAX_USD_PER_MARKET: z.coerce.number().positive().default(50),
  MIN_ORDER_USD: z.coerce.number().positive().default(1),

  DISCOVERY_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(1000),
  WS_ENABLED: z.string().optional(),
  TARGET_USER_SLUG: z.string().default('elon-musk'),
  MARKET_MIN_DAYS: z.coerce.number().positive().default(1.5),
  MARKET_MAX_DAYS: z.coerce.number().positive().default(3.5),
  FRESH_PRICE_THRESHOLD: z.coerce.number().min(0).max(1).default(0.05),

  KILL_SWITCH_MAX_ERRORS: z.coerce.number().int().positive().default(10),
  KILL_SWITCH_MAX_DRAWDOWN_USD: z.coerce.number().positive().default(100),
});

// ──────────────────────────────────────────────────────────────
// Parse + post-validate
// ──────────────────────────────────────────────────────────────

const parsed = EnvSchema.safeParse(process.env);
if (!parsed.success) {
  // eslint-disable-next-line no-console
  console.error('❌ Invalid environment configuration:');
  for (const issue of parsed.error.issues) {
    // eslint-disable-next-line no-console
    console.error(`  ${issue.path.join('.')}: ${issue.message}`);
  }
  process.exit(1);
}

const env = parsed.data;

// Live-mode requires credentials
if (env.TRADE_MODE === 'live') {
  const missing: string[] = [];
  if (!env.WALLET_PRIVATE_KEY) missing.push('WALLET_PRIVATE_KEY');
  if (!env.CLOB_API_KEY) missing.push('CLOB_API_KEY');
  if (!env.CLOB_SECRET) missing.push('CLOB_SECRET');
  if (!env.CLOB_PASS_PHRASE) missing.push('CLOB_PASS_PHRASE');
  if (!env.POLYMARKET_PROXY_ADDRESS) missing.push('POLYMARKET_PROXY_ADDRESS');
  if (missing.length) {
    // eslint-disable-next-line no-console
    console.error(
      `❌ TRADE_MODE=live but missing required env vars: ${missing.join(', ')}`
    );
    process.exit(1);
  }
}

const ladderPrices = csvFloats(env.LADDER_PRICES);
const ladderSplit = csvFloats(env.LADDER_SIZE_SPLIT);

if (ladderPrices.length !== ladderSplit.length) {
  // eslint-disable-next-line no-console
  console.error(
    `❌ LADDER_PRICES (${ladderPrices.length}) and LADDER_SIZE_SPLIT ` +
      `(${ladderSplit.length}) must have the same length.`
  );
  process.exit(1);
}

const splitSum = ladderSplit.reduce((a, b) => a + b, 0);
if (Math.abs(splitSum - 1) > 0.001) {
  // eslint-disable-next-line no-console
  console.error(`❌ LADDER_SIZE_SPLIT must sum to 1.0 (got ${splitSum})`);
  process.exit(1);
}

// ──────────────────────────────────────────────────────────────
// Export typed config
// ──────────────────────────────────────────────────────────────

export interface Config {
  tradeMode: 'paper' | 'live';
  logLevel: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';
  logPretty: boolean;

  dbPath: string;

  clobHost: string;
  gammaHost: string;
  polygonRpcUrl: string;

  credentials: {
    walletPrivateKey: string | undefined;
    clobApiKey: string | undefined;
    clobSecret: string | undefined;
    clobPassPhrase: string | undefined;
    polymarketProxyAddress: string | undefined;
  };

  strategy: {
    bankrollUsd: number;
    ladderPrices: number[];
    ladderSplit: number[];
    maxUsdPerMarket: number;
    minOrderUsd: number;
  };

  discovery: {
    pollIntervalMs: number;
    wsEnabled: boolean;
    targetUserSlug: string;
    marketMinDays: number;
    marketMaxDays: number;
    freshPriceThreshold: number;
  };

  risk: {
    killSwitchMaxErrors: number;
    killSwitchMaxDrawdownUsd: number;
  };
}

export const config: Config = {
  tradeMode: env.TRADE_MODE,
  logLevel: env.LOG_LEVEL,
  logPretty: boolish(env.LOG_PRETTY, true),

  dbPath: env.DB_PATH,

  clobHost: env.CLOB_HOST,
  gammaHost: env.GAMMA_HOST,
  polygonRpcUrl: env.POLYGON_RPC_URL,

  credentials: {
    walletPrivateKey: env.WALLET_PRIVATE_KEY,
    clobApiKey: env.CLOB_API_KEY,
    clobSecret: env.CLOB_SECRET,
    clobPassPhrase: env.CLOB_PASS_PHRASE,
    polymarketProxyAddress: env.POLYMARKET_PROXY_ADDRESS,
  },

  strategy: {
    bankrollUsd: env.BANKROLL_USD,
    ladderPrices,
    ladderSplit,
    maxUsdPerMarket: env.MAX_USD_PER_MARKET,
    minOrderUsd: env.MIN_ORDER_USD,
  },

  discovery: {
    pollIntervalMs: env.DISCOVERY_POLL_INTERVAL_MS,
    wsEnabled: boolish(env.WS_ENABLED, true),
    targetUserSlug: env.TARGET_USER_SLUG,
    marketMinDays: env.MARKET_MIN_DAYS,
    marketMaxDays: env.MARKET_MAX_DAYS,
    freshPriceThreshold: env.FRESH_PRICE_THRESHOLD,
  },

  risk: {
    killSwitchMaxErrors: env.KILL_SWITCH_MAX_ERRORS,
    killSwitchMaxDrawdownUsd: env.KILL_SWITCH_MAX_DRAWDOWN_USD,
  },
};
