-- ──────────────────────────────────────────────────────────────
-- hft-elon-bot — SQLite schema
-- Applied idempotently on every DB open by data/db.ts
-- ──────────────────────────────────────────────────────────────

PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;

-- ───── markets ────────────────────────────────────────────────
-- One row per Polymarket event we have ever seen (snipe target).
CREATE TABLE IF NOT EXISTS markets (
  slug          TEXT PRIMARY KEY,
  question      TEXT,
  neg_risk      INTEGER NOT NULL DEFAULT 0,          -- 0/1, picks verifyingContract
  start_ts      TEXT NOT NULL,
  end_ts        TEXT NOT NULL,
  duration_days REAL NOT NULL,
  detected_at   TEXT NOT NULL,                       -- ISO timestamp of first sight
  status        TEXT NOT NULL DEFAULT 'open',        -- open | resolved | expired | skipped
  winning_outcome TEXT,
  resolved_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_markets_status   ON markets(status);
CREATE INDEX IF NOT EXISTS idx_markets_detected ON markets(detected_at);

-- ───── outcomes ───────────────────────────────────────────────
-- One row per outcome (bucket) inside a market — e.g. "200-219", "<20".
CREATE TABLE IF NOT EXISTS outcomes (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  market_slug     TEXT NOT NULL REFERENCES markets(slug),
  group_item_title TEXT NOT NULL,
  token_id_yes    TEXT NOT NULL,                     -- clobTokenIds[0]
  token_id_no     TEXT,                              -- clobTokenIds[1]
  tick_size       REAL,
  min_order_size  REAL,                              -- `mos` from getClobMarketInfo
  UNIQUE(market_slug, group_item_title)
);
CREATE INDEX IF NOT EXISTS idx_outcomes_market ON outcomes(market_slug);

-- ───── orders ─────────────────────────────────────────────────
-- Every order we attempted (paper or live).
CREATE TABLE IF NOT EXISTS orders (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  market_slug     TEXT NOT NULL,
  outcome_title   TEXT NOT NULL,
  token_id        TEXT NOT NULL,
  mode            TEXT NOT NULL,                     -- paper | live
  side            TEXT NOT NULL,                     -- BUY | SELL
  price           REAL NOT NULL,                     -- limit price 0..1
  size_usd        REAL NOT NULL,                     -- intended USD notional
  size_shares     REAL,                              -- size_usd / price
  status          TEXT NOT NULL DEFAULT 'pending',   -- pending | placed | filled | partial | canceled | error | rejected
  clob_order_id   TEXT,
  error_msg       TEXT,
  placed_at       TEXT NOT NULL,
  acked_at        TEXT,                              -- when CLOB returned (latency tracking)
  latency_ms      INTEGER,
  filled_size     REAL DEFAULT 0,
  avg_fill_price  REAL
);
CREATE INDEX IF NOT EXISTS idx_orders_market ON orders(market_slug);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_placed ON orders(placed_at);

-- ───── fills ──────────────────────────────────────────────────
-- Individual fill events (one order may fill in multiple chunks).
CREATE TABLE IF NOT EXISTS fills (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id  INTEGER NOT NULL REFERENCES orders(id),
  size      REAL NOT NULL,
  price     REAL NOT NULL,
  ts        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_fills_order ON fills(order_id);

-- ───── pnl ────────────────────────────────────────────────────
-- One row per resolved position (per market+outcome we held).
CREATE TABLE IF NOT EXISTS pnl (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  market_slug   TEXT NOT NULL,
  outcome_title TEXT NOT NULL,
  entry_price   REAL NOT NULL,                       -- weighted avg
  size_shares   REAL NOT NULL,
  outcome_won   INTEGER NOT NULL,                    -- 0 | 1
  pnl_usd       REAL NOT NULL,                       -- realized
  resolved_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pnl_market ON pnl(market_slug);

-- ───── events ─────────────────────────────────────────────────
-- Free-form event log for postmortems (kill-switch trips, errors, etc.)
CREATE TABLE IF NOT EXISTS events (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  ts      TEXT NOT NULL,
  level   TEXT NOT NULL,                             -- info | warn | error
  kind    TEXT NOT NULL,                             -- short tag
  payload TEXT                                       -- JSON
);
CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
