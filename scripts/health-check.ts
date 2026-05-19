/**
 * health-check.ts — is the bot alive AND making progress?
 *
 * pm2 already restarts crashed processes. This script catches the harder
 * case: a "zombie" — process alive but doing nothing (WS died silently,
 * poller stuck, etc.).
 *
 * Healthy = at least one DB write to `events` in the last N seconds.
 *
 * Exit codes:
 *   0  healthy
 *   1  unhealthy (no recent activity)
 *   2  bot pid file missing or process not alive
 *
 * Usage:
 *   npm run health                    # default 300s window
 *   npm run health -- 600             # 600s window
 *   cron: */5 * * * * cd /opt/hft-elon-bot && npm run health || systemctl restart pm2-...
 */

import { existsSync, readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { db, closeDb } from '../src/data/db.js';
import { logger } from '../src/lib/logger.js';

const log = logger.child({ mod: 'health' });

const DEFAULT_WINDOW_SEC = 300;

function checkProcess(): { pid: number; alive: boolean } | null {
  const f = './data/bot.pid';
  if (!existsSync(f)) return null;
  const pid = parseInt(readFileSync(f, 'utf8').trim(), 10);
  if (!Number.isFinite(pid)) return null;
  try {
    execSync(`ps -p ${pid} > /dev/null 2>&1`);
    return { pid, alive: true };
  } catch {
    return { pid, alive: false };
  }
}

function lastEventAgeSec(): number | null {
  const row = db
    .prepare(`SELECT MAX(ts) AS last_ts FROM events`)
    .get() as { last_ts: string | null };
  if (!row?.last_ts) return null;
  const ageMs = Date.now() - new Date(row.last_ts).getTime();
  return Math.round(ageMs / 1000);
}

function main(): void {
  const arg = process.argv[2];
  const windowSec = arg ? Math.max(30, parseInt(arg, 10)) : DEFAULT_WINDOW_SEC;

  const proc = checkProcess();
  if (!proc) {
    log.error('no bot.pid file — bot was never started or pid file deleted');
    closeDb();
    process.exit(2);
  }
  if (!proc.alive) {
    log.error({ pid: proc.pid }, 'bot pid file present but process is dead');
    closeDb();
    process.exit(2);
  }

  const ageSec = lastEventAgeSec();
  if (ageSec === null) {
    log.warn({ pid: proc.pid }, 'process alive but DB has no events at all');
    closeDb();
    process.exit(1);
  }

  if (ageSec > windowSec) {
    log.warn(
      { pid: proc.pid, lastEventAgeSec: ageSec, windowSec },
      `last DB write was ${ageSec}s ago (> ${windowSec}s) — ZOMBIE?`
    );
    closeDb();
    process.exit(1);
  }

  log.info(
    { pid: proc.pid, lastEventAgeSec: ageSec, windowSec },
    '✅ healthy'
  );
  closeDb();
  process.exit(0);
}

main();
