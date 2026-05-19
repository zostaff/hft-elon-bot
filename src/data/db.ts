/**
 * db.ts — synchronous SQLite wrapper.
 *
 * Uses better-sqlite3 because:
 *   - sync API → no Promise overhead on hot insert path
 *   - WAL mode → readers don't block writers
 *   - single-process bot → no concurrent-writer issues
 *
 * On import: opens the DB, applies schema idempotently, exposes prepared
 * statements as named exports.
 */

import Database from 'better-sqlite3';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';
import { logger } from '../lib/logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const log = logger.child({ mod: 'db' });

// Ensure parent dir exists (better-sqlite3 won't create it)
mkdirSync(dirname(resolve(config.dbPath)), { recursive: true });

export const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('foreign_keys = ON');

// Apply schema (idempotent)
const schemaPath = resolve(__dirname, 'schema.sql');
const schemaSql = readFileSync(schemaPath, 'utf8');
db.exec(schemaSql);

log.info({ path: config.dbPath }, 'sqlite ready');

// ──────────────────────────────────────────────────────────────
// Domain types (mirror schema.sql)
// ──────────────────────────────────────────────────────────────

export interface MarketRow {
  slug: string;
  question: string | null;
  neg_risk: number;
  start_ts: string;
  end_ts: string;
  duration_days: number;
  detected_at: string;
  status: 'open' | 'resolved' | 'expired' | 'skipped';
  winning_outcome: string | null;
  resolved_at: string | null;
}

export interface OutcomeRow {
  id: number;
  market_slug: string;
  group_item_title: string;
  token_id_yes: string;
  token_id_no: string | null;
  tick_size: number | null;
  min_order_size: number | null;
}

export interface OrderRow {
  id: number;
  market_slug: string;
  outcome_title: string;
  token_id: string;
  mode: 'paper' | 'live';
  side: 'BUY' | 'SELL';
  price: number;
  size_usd: number;
  size_shares: number | null;
  status:
    | 'pending'
    | 'placed'
    | 'filled'
    | 'partial'
    | 'canceled'
    | 'error'
    | 'rejected';
  clob_order_id: string | null;
  error_msg: string | null;
  placed_at: string;
  acked_at: string | null;
  latency_ms: number | null;
  filled_size: number;
  avg_fill_price: number | null;
}

// ──────────────────────────────────────────────────────────────
// Prepared statements
// ──────────────────────────────────────────────────────────────

const stmt = {
  // markets
  insertMarket: db.prepare<[
    string, string | null, number, string, string, number, string,
  ]>(`
    INSERT OR IGNORE INTO markets
      (slug, question, neg_risk, start_ts, end_ts, duration_days, detected_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `),
  getMarket: db.prepare<[string]>(`SELECT * FROM markets WHERE slug = ?`),
  listOpenMarkets: db.prepare(`SELECT * FROM markets WHERE status = 'open'`),

  // outcomes
  insertOutcome: db.prepare<[
    string, string, string, string | null, number | null, number | null,
  ]>(`
    INSERT OR IGNORE INTO outcomes
      (market_slug, group_item_title, token_id_yes, token_id_no, tick_size, min_order_size)
    VALUES (?, ?, ?, ?, ?, ?)
  `),
  listOutcomes: db.prepare<[string]>(
    `SELECT * FROM outcomes WHERE market_slug = ?`
  ),

  // orders
  insertOrder: db.prepare<[
    string, string, string, 'paper' | 'live', 'BUY' | 'SELL',
    number, number, number | null, string,
  ]>(`
    INSERT INTO orders
      (market_slug, outcome_title, token_id, mode, side,
       price, size_usd, size_shares, placed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `),
  updateOrderAck: db.prepare<[
    'placed' | 'rejected' | 'error', string | null, string | null,
    string | null, number | null, number,
  ]>(`
    UPDATE orders
       SET status = ?, clob_order_id = ?, error_msg = ?,
           acked_at = ?, latency_ms = ?
     WHERE id = ?
  `),

  // events
  insertEvent: db.prepare<[string, string, string, string | null]>(`
    INSERT INTO events (ts, level, kind, payload) VALUES (?, ?, ?, ?)
  `),
};

// ──────────────────────────────────────────────────────────────
// Public helpers
// ──────────────────────────────────────────────────────────────

export function recordMarket(m: {
  slug: string;
  question: string | null;
  negRisk: boolean;
  startTs: string;
  endTs: string;
  durationDays: number;
}): boolean {
  const res = stmt.insertMarket.run(
    m.slug,
    m.question,
    m.negRisk ? 1 : 0,
    m.startTs,
    m.endTs,
    m.durationDays,
    new Date().toISOString()
  );
  return res.changes > 0;
}

export function recordOutcome(o: {
  marketSlug: string;
  title: string;
  tokenIdYes: string;
  tokenIdNo: string | null;
  tickSize: number | null;
  minOrderSize: number | null;
}): void {
  stmt.insertOutcome.run(
    o.marketSlug,
    o.title,
    o.tokenIdYes,
    o.tokenIdNo,
    o.tickSize,
    o.minOrderSize
  );
}

export function insertOrder(o: {
  marketSlug: string;
  outcomeTitle: string;
  tokenId: string;
  mode: 'paper' | 'live';
  side: 'BUY' | 'SELL';
  price: number;
  sizeUsd: number;
}): number {
  const sizeShares = o.price > 0 ? o.sizeUsd / o.price : null;
  const res = stmt.insertOrder.run(
    o.marketSlug,
    o.outcomeTitle,
    o.tokenId,
    o.mode,
    o.side,
    o.price,
    o.sizeUsd,
    sizeShares,
    new Date().toISOString()
  );
  return Number(res.lastInsertRowid);
}

export function ackOrder(o: {
  id: number;
  status: 'placed' | 'rejected' | 'error';
  clobOrderId: string | null;
  errorMsg: string | null;
  latencyMs: number | null;
}): void {
  stmt.updateOrderAck.run(
    o.status,
    o.clobOrderId,
    o.errorMsg,
    new Date().toISOString(),
    o.latencyMs,
    o.id
  );
}

export function getMarket(slug: string): MarketRow | undefined {
  return stmt.getMarket.get(slug) as MarketRow | undefined;
}

export function listOpenMarkets(): MarketRow[] {
  return stmt.listOpenMarkets.all() as MarketRow[];
}

export function listOutcomes(slug: string): OutcomeRow[] {
  return stmt.listOutcomes.all(slug) as OutcomeRow[];
}

export function logEvent(
  level: 'info' | 'warn' | 'error',
  kind: string,
  payload?: Record<string, unknown>
): void {
  stmt.insertEvent.run(
    new Date().toISOString(),
    level,
    kind,
    payload ? JSON.stringify(payload) : null
  );
}

export function closeDb(): void {
  db.close();
}
