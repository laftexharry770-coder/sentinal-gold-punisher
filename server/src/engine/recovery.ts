import {
  commissionFor,
  getSymbolSpec,
  priceDistanceToUsd,
  roundLot,
  usdToPriceDistance,
  type BotConfig,
  type ClosedTrade,
  type RecoveryTask,
  type Side,
  type Signal,
} from '@sentinal/shared';
import { round, uid } from '../util.js';

export interface RecoveryPlan {
  task: RecoveryTask;
  side: Side;
  /** Volume of each leg — several legs are fired together when one is capped. */
  legVolume: number;
  legs: number;
  projectedNet: number;
}

/**
 * Zero-Loss Recovery.
 *
 * Losses accumulate into a deficit. A recovery is only released when the
 * projected result of the recovery legs clears the whole deficit *and* leaves
 * the configured minimum profit on top — otherwise it stays postponed with a
 * readable hold reason. If a single leg cannot carry the deficit, the plan is
 * split across several legs fired simultaneously, one per remaining layer.
 */
export class RecoveryEngine {
  private deficit = 0;
  private layer = 0;
  private tasks: RecoveryTask[] = [];
  private pending: RecoveryTask | null = null;
  private sourceTrades: string[] = [];

  get pendingDeficit(): number {
    return round(this.deficit);
  }

  get currentLayer(): number {
    return this.layer;
  }

  list(): RecoveryTask[] {
    return this.pending ? [this.pending, ...this.tasks] : [...this.tasks];
  }

  reset(): void {
    this.deficit = 0;
    this.layer = 0;
    this.pending = null;
    this.sourceTrades = [];
  }

  /** Books a losing trade into the deficit pool. */
  registerLoss(trade: ClosedTrade): void {
    this.deficit = round(this.deficit + Math.abs(trade.netProfit));
    this.sourceTrades.push(trade.id);
    if (this.sourceTrades.length > 50) this.sourceTrades.shift();
    if (trade.origin === 'recovery') this.layer = trade.recoveryLayer + 1;
  }

  /** Applies a winning trade against the outstanding deficit. */
  registerGain(trade: ClosedTrade): boolean {
    if (this.deficit <= 0) return false;
    this.deficit = round(Math.max(0, this.deficit - trade.netProfit));
    if (this.deficit <= 0.009) {
      this.deficit = 0;
      this.layer = 0;
      this.sourceTrades = [];
      if (this.pending) {
        this.pending.status = 'cancelled';
        this.pending.holdReason = 'deficit cleared';
        this.archive(this.pending);
        this.pending = null;
      }
      return true;
    }
    return false;
  }

  private archive(task: RecoveryTask): void {
    this.tasks.unshift(task);
    if (this.tasks.length > 40) this.tasks.pop();
  }

  private hold(accountId: string, cfg: BotConfig, side: Side, reason: string, volume = 0, projected = 0): null {
    const task: RecoveryTask = this.pending ?? {
      id: uid('rec'),
      accountId,
      symbol: cfg.symbol,
      deficit: this.deficit,
      side,
      layer: this.layer,
      volume,
      projectedNet: projected,
      status: 'pending',
      createdAt: Date.now(),
      holdReason: reason,
      sourceTradeIds: [...this.sourceTrades],
    };
    task.deficit = round(this.deficit);
    task.side = side;
    task.layer = this.layer;
    task.volume = volume;
    task.projectedNet = round(projected);
    task.status = 'pending';
    task.holdReason = reason;
    task.sourceTradeIds = [...this.sourceTrades];
    this.pending = task;
    return null;
  }

  /**
   * Returns a releasable plan, or null while the recovery stays postponed.
   * `null` always leaves a pending task behind carrying the hold reason.
   */
  plan(accountId: string, cfg: BotConfig, signal: Signal | null): RecoveryPlan | null {
    if (!cfg.zeroLoss.enabled || this.deficit <= 0) {
      if (this.pending && this.deficit <= 0) {
        this.pending.status = 'cancelled';
        this.archive(this.pending);
        this.pending = null;
      }
      return null;
    }

    const spec = getSymbolSpec(cfg.symbol);
    const fallbackSide: Side = signal?.side ?? 'buy';

    if (this.layer >= cfg.zeroLoss.maxRecoveryLayers) {
      return this.hold(accountId, cfg, fallbackSide, `max recovery layers reached (${cfg.zeroLoss.maxRecoveryLayers})`);
    }
    if (cfg.zeroLoss.requireSignalAlignment && (!signal || !signal.side || signal.strength < 0.3)) {
      return this.hold(accountId, cfg, fallbackSide, 'postponed — waiting for an aligned signal');
    }

    const side: Side = signal?.side ?? fallbackSide;
    const targetDistance = usdToPriceDistance(spec, cfg.lotSize, cfg.takeProfitUsd);
    if (targetDistance <= 0) return this.hold(accountId, cfg, side, 'invalid target distance');

    const needed = this.deficit + cfg.zeroLoss.minNetProfitUsd;
    const rawVolume = (needed / (targetDistance * spec.contractSize)) * cfg.zeroLoss.recoveryMultiplier;

    const layersLeft = Math.max(1, cfg.zeroLoss.maxRecoveryLayers - this.layer);
    const cap = Math.max(spec.minLot, cfg.zeroLoss.maxRecoveryLot);
    const legs = Math.min(layersLeft, Math.max(1, Math.ceil(rawVolume / cap)));
    const legVolume = roundLot(spec, Math.max(spec.minLot, rawVolume / legs));
    const totalVolume = round(legVolume * legs);

    const grossTarget = priceDistanceToUsd(spec, totalVolume, targetDistance);
    const cost = commissionFor(spec, totalVolume);
    const projectedNet = round(grossTarget - cost - this.deficit);

    if (legVolume > cap + 1e-9) {
      return this.hold(
        accountId,
        cfg,
        side,
        `postponed — needs ${totalVolume.toFixed(2)} lots, above the ${cap.toFixed(2)} cap`,
        legVolume,
        projectedNet,
      );
    }
    if (projectedNet < cfg.zeroLoss.minNetProfitUsd) {
      return this.hold(
        accountId,
        cfg,
        side,
        `postponed — projected ${projectedNet.toFixed(2)} below the ${cfg.zeroLoss.minNetProfitUsd.toFixed(2)} floor`,
        legVolume,
        projectedNet,
      );
    }

    const task: RecoveryTask = this.pending ?? {
      id: uid('rec'),
      accountId,
      symbol: cfg.symbol,
      deficit: round(this.deficit),
      side,
      layer: this.layer,
      volume: legVolume,
      projectedNet,
      status: 'armed',
      createdAt: Date.now(),
      holdReason: '',
      sourceTradeIds: [...this.sourceTrades],
    };
    task.side = side;
    task.deficit = round(this.deficit);
    task.volume = legVolume;
    task.layer = this.layer;
    task.projectedNet = projectedNet;
    task.status = 'armed';
    task.holdReason = '';
    this.pending = task;

    return { task, side, legVolume, legs, projectedNet };
  }

  /** Marks the pending task as released once its legs are actually on the book. */
  markFired(plan: RecoveryPlan): void {
    plan.task.status = 'fired';
    this.archive(plan.task);
    this.pending = null;
    this.layer += 1;
  }
}
