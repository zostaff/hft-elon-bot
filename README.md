# hft-elon-bot

Polymarket CLOB V2 sniper for newly-created 2-day Elon-tweet markets.

Detects market creation via the Polymarket WebSocket Market channel
(`custom_feature_enabled=true` for `new_market` events), with a Gamma REST
polling fallback. On a target market, places a ladder of low-price limit BUY
orders across every outcome before liquidity arrives, then holds to
resolution.

## Status

| Phase | What | State |
|---|---|---|
| 0 | Bootstrap (package, tsconfig, .env, SQLite, logger) | ✅ |
| 1 | Discovery (WS fast-path + Gamma polling + dedup) | ✅ |
| 2 | Paper snipe (ladder, inventory, paper exec, engine) | ✅ |
| 3 | Live infra (CLOB V2 client, kill-switch, setup-creds) | ✅ coded, not yet tested live |
| 4 | Optimizations (warmup, latency probe, dashboard) | ✅ (4.3 fill-sim deferred) |
| 5 | VPS deploy (pm2 + install.sh) | 🟡 artifacts ready |

Paper-mode validated end-to-end via `npm run simulate`. Live-mode requires
real credentials and a small pUSD balance — see *Going live* below.

## Architecture

```
src/
├── discovery/      WS fast-path + Gamma polling, dedup by slug
│   ├── poller.ts   Gamma /events every 1s, first-poll suppression
│   ├── ws-watcher.ts  WSS + ping/pong + exp-backoff reconnect
│   ├── filter.ts   pure: evaluateEvent → pass/reason
│   └── index.ts    DiscoveryManager (compose + cross-source dedup)
├── trader/
│   ├── ladder.ts   price × split → orders + skipped slots
│   └── snipe-engine.ts  MarketCandidate → ladder → inventory → executor
├── exec/
│   ├── paper.ts    DB insert + ack, no network
│   └── live.ts     @polymarket/clob-client-v2 createAndPostOrder (parallel)
├── risk/
│   ├── inventory.ts  per-market cap + bankroll cap, rebuilt from DB
│   └── kill-switch.ts  error-rate + drawdown gate
├── lib/
│   ├── clob.ts     CLOB V2 client wrapper (L1 wallet + L2 HMAC)
│   ├── gamma.ts    undici Pool, fetchTweetEvents, fetchEventBySlug
│   ├── warmup.ts   TLS prewarm + keepalive (Gamma + CLOB)
│   └── logger.ts   pino + pretty
└── data/
    ├── schema.sql  markets, outcomes, orders, fills, pnl, events
    └── db.ts       better-sqlite3 (WAL) + prepared statements
```

## Quick start

```bash
nvm use                  # node 24 (matches better-sqlite3 prebuild)
npm install
cp .env.example .env

npm run smoke            # gamma + db reachability
npm run simulate         # forced paper snipe on a current market
npm run stats            # dashboard: markets, orders, latency, inventory
npm run start            # run the bot in foreground (paper mode by default)
```

## Strategy

Competitors enter new 2-day Elon markets at 1.5-3.8¢ per share before real
liquidity arrives. The bot mirrors that:

- Ladder prices: `0.015, 0.025, 0.035`
- Split: `40% / 30% / 30%` of per-bucket budget
- Per-market cap: `$50` (10 buckets × 3 levels ≈ $5/bucket)
- Bankroll: `$200`
- Hold to resolution — if any bucket wins, payout (`1 share = $1`) covers all
  losing buckets several times over.

All parameters live in `.env` (see `.env.example`).

## Going live

> Currently runs in `paper` mode by default. Live mode requires explicit
> credential setup and is gated by `kill-switch.ts` (auto-revert to safe on
> repeated errors / drawdown).

```bash
# 1. fund a fresh Polygon wallet and your Polymarket proxy (pUSD)
# 2. put WALLET_PRIVATE_KEY in .env
npm run setup-creds      # L1 signature → L2 HMAC creds (CLOB_API_KEY/SECRET/PASS)
# 3. paste returned values into .env
npm run check-live       # balance + allowance preflight
npm run latency 20       # confirm <80ms to clob.polymarket.com
# 4. flip TRADE_MODE=live in .env, restart
```

## Deploy on VPS

```bash
git clone https://github.com/zostaff/hft-elon-bot.git
cd hft-elon-bot
./scripts/deploy/install.sh        # node 24 via nvm, pm2, deps, native rebuild
# copy your .env (never commit it)
pm2 start ecosystem.config.cjs
pm2 save && pm2 startup            # follow prompt → auto-start on reboot
pm2 logs hft-elon-bot
```

## Scripts

| Command | Purpose |
|---|---|
| `npm run start` | Run the bot (paper or live per `.env`) |
| `npm run dev` | tsx watch — auto-reload on file change |
| `npm run smoke` | Gamma + DB sanity check |
| `npm run simulate` | Force a paper snipe on a current market |
| `npm run stats` | Dashboard: markets, orders, latency, inventory, events |
| `npm run latency [n]` | Probe Gamma/CLOB latency (n samples, default 10) |
| `npm run health [sec]` | Liveness check (alive + DB activity within window) |
| `npm run setup-creds` | Derive L2 CLOB creds from L1 wallet signature |
| `npm run check-live` | pUSD balance + allowance preflight |
| `npm run typecheck` | `tsc --noEmit` |

## Configuration

Everything in `.env`. Highlights:

| Var | Default | Notes |
|---|---|---|
| `TRADE_MODE` | `paper` | `paper` or `live` |
| `BANKROLL_USD` | `200` | total cap across all markets |
| `MAX_USD_PER_MARKET` | `50` | per-market cap |
| `LADDER_PRICES` | `0.015,0.025,0.035` | CSV |
| `LADDER_SIZE_SPLIT` | `0.4,0.3,0.3` | CSV, must sum to 1 |
| `MIN_ORDER_USD` | `1` | floor; CLOB V2's `mos` is also enforced |
| `TARGET_USER_SLUG` | `elon-musk` | slug substring filter |
| `MARKET_MIN_DAYS` / `MAX_DAYS` | `1.5 / 4.5` | duration window |
| `FRESH_PRICE_THRESHOLD` | `0.05` | skip if any bucket already trades above this |
| `WS_ENABLED` | `true` | WS fast-path; polling always on |
| `DISCOVERY_POLL_INTERVAL_MS` | `1000` | Gamma polling cadence |
| `KILL_SWITCH_MAX_ERRORS` | `10` | revert live → paper after N consecutive failures |
| `KILL_SWITCH_MAX_DRAWDOWN_USD` | `100` | revert live → paper after this realized loss |

## DB

SQLite in WAL mode at `./data/bot.db`. Tables:

- `markets` — every event we've ever seen (slug, dates, status, resolution)
- `outcomes` — buckets per market with their YES/NO clobTokenIds
- `orders` — every order attempted (mode, status, price, USD, shares, latency)
- `fills` — individual fill chunks per order
- `pnl` — realized PnL per resolved position
- `events` — free-form log for postmortems (boot, snipe_complete, errors)

## Caveats

- Live execution path is untested with real creds.
- The fill simulator is deferred — paper PnL assumes "filled at limit price",
  which is the strategy's premise (first in book on a fresh market). Will be
  empirically validated once real-market data accumulates.
- Mac dev latency to clob.polymarket.com is ~150-250ms (p50). VPS in
  us-east-1 is required for competitive live execution.

## Stack

- TypeScript 5, Node 24
- `@polymarket/clob-client-v2` (CLOB V2)
- `viem` (EIP-712 signing)
- `undici` (HTTP/2 keep-alive Gamma/CLOB)
- `ws` (Polymarket WSS)
- `better-sqlite3` (WAL)
- `pino` + `pino-pretty` (logging)
- `zod` (env validation)
- pm2 (production process manager)
