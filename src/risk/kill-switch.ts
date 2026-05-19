/**
 * kill-switch.ts — last line of defence before catastrophic loss.
 *
 * Two independent triggers, either flips live mode → paper for the rest of
 * the process (DB is updated, alerts logged). Reset requires bot restart —
 * deliberate, so a flapping kill-switch doesn't silently re-enable trading.
 *
 *   1. CONSECUTIVE_ERRORS    → likely API outage / wrong creds / banned
 *   2. REALIZED_DRAWDOWN_USD → strategy is losing more than expected
 *
 * Paper mode is unaffected — these gates only apply to live placement.
 */

import { logger } from '../lib/logger.js';
import { config } from '../config.js';
import { logEvent } from '../data/db.js';

const log = logger.child({ mod: 'kill-switch' });

class KillSwitch {
  private consecutiveErrors = 0;
  private realizedLossUsd = 0;
  private tripped = false;
  private trippedReason: string | null = null;

  /** Call on every live-order placement result. */
  recordLiveOrder(success: boolean, errorMsg?: string | null): void {
    if (success) {
      if (this.consecutiveErrors > 0) {
        log.info(
          { wasAt: this.consecutiveErrors },
          'kill-switch: error streak reset'
        );
      }
      this.consecutiveErrors = 0;
      return;
    }

    this.consecutiveErrors += 1;
    log.warn(
      {
        consecutive: this.consecutiveErrors,
        max: config.risk.killSwitchMaxErrors,
        errorMsg,
      },
      'kill-switch: live order error counted'
    );

    if (this.consecutiveErrors >= config.risk.killSwitchMaxErrors) {
      this.trip(
        `consecutive_errors=${this.consecutiveErrors} >= ${config.risk.killSwitchMaxErrors}`
      );
    }
  }

  /** Call when a market resolves and a position closes at a loss. */
  recordRealizedLoss(usd: number): void {
    if (usd <= 0) return;
    this.realizedLossUsd += usd;
    log.warn(
      {
        lossUsd: usd,
        totalLossUsd: Math.round(this.realizedLossUsd * 100) / 100,
        max: config.risk.killSwitchMaxDrawdownUsd,
      },
      'kill-switch: realized loss counted'
    );
    if (this.realizedLossUsd >= config.risk.killSwitchMaxDrawdownUsd) {
      this.trip(
        `realized_loss=$${this.realizedLossUsd.toFixed(2)} >= $${config.risk.killSwitchMaxDrawdownUsd}`
      );
    }
  }

  /** True ⇒ refuse any live placement until restart. */
  isTripped(): boolean {
    return this.tripped;
  }

  /** Reason string if tripped, null otherwise. */
  trippedReasonText(): string | null {
    return this.trippedReason;
  }

  private trip(reason: string): void {
    if (this.tripped) return;
    this.tripped = true;
    this.trippedReason = reason;
    log.fatal({ reason }, '🛑 KILL-SWITCH TRIPPED — live placements blocked');
    logEvent('error', 'kill_switch_tripped', { reason });
  }

  getStats(): {
    tripped: boolean;
    reason: string | null;
    consecutiveErrors: number;
    realizedLossUsd: number;
  } {
    return {
      tripped: this.tripped,
      reason: this.trippedReason,
      consecutiveErrors: this.consecutiveErrors,
      realizedLossUsd: Math.round(this.realizedLossUsd * 100) / 100,
    };
  }
}

export const killSwitch = new KillSwitch();
