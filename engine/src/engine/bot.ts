import { Emitter } from '../emitter.js';
import {
  DEFAULT_BOT_CONFIG,
  type Candle,
  getSymbolSpec,
  type BotConfig,
  type BotStats,
  type ClosedTrade,
  type Position,
  type Side,
  type Signal,
  type Tick,
} from '@sentinal/shared';
import type { TradingAccount } from '../broker/account.js';
import type { AccountManager } from '../broker/manager.js';
import type { Journal } from '../journal.js';
import { round, startOfDay } from '../util.js';
import { RecoveryEngine } from './recovery.js';
import { StrategyEngine } from './strategy.js';

/** Positions the bot itself is responsible for (copies belong to the copier). */
const BOT_ORIGINS = new Set(['bot', 'recovery']);

export class BotEngine extends Emitter {
  config: BotConfig = { ...DEFAULT_BOT_CONFIG, zeroLoss: { ...DEFAULT_BOT_CONFIG.zeroLoss } };
  private readonly strategy = new StrategyEngine();
  private readonly recoveries = new Map<string, RecoveryEngine>();

  private running = false;
  private startedAt: number | null = null;
  private busy = false;
  private lastBurstAt = 0;
  private lastBarTime = 0;
  private dayStamp = startOfDay(Date.now());
  private haltReason: string | null = null;
  private lastSignal: Signal | null = null;
  private spreadWarnedAt = 0;

  private counters = {
    signalsEvaluated: 0,
    tradesOpened: 0,
    tradesClosed: 0,
    wins: 0,
    losses: 0,
    grossProfit: 0,
    grossLoss: 0,
    dailyTrades: 0,
    dailyProfit: 0,
  };

  constructor(
    private readonly accounts: AccountManager,
    private readonly journal: Journal,
  ) {
    super();
    this.accounts.on('closed', (trade: ClosedTrade) => this.onTradeClosed(trade));
  }

  /* --------------------------------------------------------------- */
  /* Lifecycle                                                        */
  /* --------------------------------------------------------------- */

  /**
   * Warms the indicator set from historical bars.
   *
   * Without this the strategy needs ~34 live ticks before it reports ready, so
   * an operator arming the bot would watch it do nothing for a quarter of a
   * minute. Loading history first is what a terminal does anyway.
   */
  prime(candles: Candle[]): void {
    for (const candle of candles) {
      this.strategy.update({
        symbol: this.config.symbol,
        bid: candle.close,
        ask: candle.close,
        time: candle.time,
      });
    }
  }

  start(): void {
    if (this.running) return;
    const account = this.accounts.primary();
    if (!account) {
      this.journal.write('error', null, 'Cannot start: link a broker account first');
      return;
    }
    this.running = true;
    this.config.enabled = true;
    this.startedAt = Date.now();
    this.haltReason = null;
    this.journal.write(
      'success',
      account.id,
      `Bot armed on ${this.config.symbol} — ${this.config.strategy}, ${this.config.entriesPerSignal} leg(s)/signal, up to ${this.config.maxConcurrentPositions} concurrent`,
    );
    this.publish();
  }

  stop(closePositions = false): void {
    if (!this.running && !closePositions) return;
    this.running = false;
    this.config.enabled = false;
    if (closePositions) {
      for (const account of this.accounts.list()) {
        const closed = account.closeAll('bot-stop', (p) => BOT_ORIGINS.has(p.origin));
        if (closed.length > 0) {
          this.journal.write('warn', account.id, `Flattened ${closed.length} bot position(s) on stop`);
        }
      }
    }
    this.journal.write('info', null, 'Bot disarmed');
    this.publish();
  }

  updateConfig(patch: Partial<BotConfig>): BotConfig {
    const previouslyEnabled = this.config.enabled;
    this.config = {
      ...this.config,
      ...patch,
      zeroLoss: { ...this.config.zeroLoss, ...(patch.zeroLoss ?? {}) },
    };
    if (patch.enabled === true && !previouslyEnabled) this.start();
    else if (patch.enabled === false && previouslyEnabled) this.stop();
    else this.publish();
    return this.config;
  }

  recoveryFor(accountId: string): RecoveryEngine {
    let engine = this.recoveries.get(accountId);
    if (!engine) {
      engine = new RecoveryEngine();
      this.recoveries.set(accountId, engine);
    }
    return engine;
  }

  listRecoveries() {
    return [...this.recoveries.values()].flatMap((engine) => engine.list());
  }

  stats(): BotStats {
    let pendingDeficit = 0;
    for (const engine of this.recoveries.values()) pendingDeficit += engine.pendingDeficit;
    return {
      running: this.running,
      startedAt: this.startedAt,
      signalsEvaluated: this.counters.signalsEvaluated,
      tradesOpened: this.counters.tradesOpened,
      tradesClosed: this.counters.tradesClosed,
      wins: this.counters.wins,
      losses: this.counters.losses,
      grossProfit: round(this.counters.grossProfit),
      grossLoss: round(this.counters.grossLoss),
      netProfit: round(this.counters.grossProfit - this.counters.grossLoss),
      pendingDeficit: round(pendingDeficit),
      dailyTrades: this.counters.dailyTrades,
      dailyProfit: round(this.counters.dailyProfit),
      lastSignal: this.lastSignal,
      haltReason: this.haltReason,
    };
  }

  private publish(): void {
    this.emit('bot', { config: this.config, stats: this.stats() });
  }

  /* --------------------------------------------------------------- */
  /* Trade bookkeeping                                                */
  /* --------------------------------------------------------------- */

  private onTradeClosed(trade: ClosedTrade): void {
    if (!BOT_ORIGINS.has(trade.origin)) return;
    this.counters.tradesClosed += 1;
    this.counters.dailyProfit = round(this.counters.dailyProfit + trade.netProfit);
    if (trade.netProfit >= 0) {
      this.counters.wins += 1;
      this.counters.grossProfit = round(this.counters.grossProfit + trade.netProfit);
    } else {
      this.counters.losses += 1;
      this.counters.grossLoss = round(this.counters.grossLoss + Math.abs(trade.netProfit));
    }

    const recovery = this.recoveryFor(trade.accountId);
    if (trade.netProfit < 0) {
      recovery.registerLoss(trade);
      if (this.config.zeroLoss.enabled) {
        this.journal.write(
          'warn',
          trade.accountId,
          `#${trade.ticket} closed ${trade.netProfit.toFixed(2)} — deficit now ${recovery.pendingDeficit.toFixed(2)}, recovery queued`,
        );
      }
    } else if (recovery.registerGain(trade)) {
      this.journal.write('success', trade.accountId, `Deficit cleared by #${trade.ticket} (+${trade.netProfit.toFixed(2)})`);
    }
    this.emit('recoveries', this.listRecoveries());
    this.publish();
  }

  /* --------------------------------------------------------------- */
  /* Tick loop                                                        */
  /* --------------------------------------------------------------- */

  async onTick(tick: Tick, barClosed: boolean): Promise<void> {
    this.strategy.update(tick);
    if (!this.running || this.busy) return;

    this.busy = true;
    try {
      await this.evaluate(tick, barClosed);
    } catch (err) {
      this.journal.write('error', null, `Engine error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.busy = false;
    }
  }

  private rollDay(now: number): void {
    const today = startOfDay(now);
    if (today === this.dayStamp) return;
    this.dayStamp = today;
    this.counters.dailyTrades = 0;
    this.counters.dailyProfit = 0;
    if (this.haltReason) {
      this.haltReason = null;
      this.journal.write('info', null, 'New trading day — daily guards reset');
    }
  }

  private async evaluate(tick: Tick, barClosed: boolean): Promise<void> {
    this.rollDay(tick.time);

    const account = this.accounts.primary();
    if (!account) return;

    // 1. Basket management runs on every tick regardless of execution mode.
    await this.manageBasket(account);

    // 2. Timing gate.
    if (this.config.execution === 'bar-close') {
      if (!barClosed || this.lastBarTime === tick.time) return;
      this.lastBarTime = tick.time;
    }

    // 3. Risk guards.
    const spread = round(tick.ask - tick.bid);
    if (spread > this.config.maxSpread) {
      if (tick.time - this.spreadWarnedAt > 30_000) {
        this.spreadWarnedAt = tick.time;
        this.journal.write('warn', account.id, `Spread ${spread.toFixed(2)} above limit ${this.config.maxSpread.toFixed(2)} — entries paused`);
      }
      return;
    }
    if (this.config.maxDailyLossUsd !== null && this.counters.dailyProfit <= -this.config.maxDailyLossUsd) {
      if (!this.haltReason) {
        this.haltReason = `daily loss limit hit (${this.counters.dailyProfit.toFixed(2)})`;
        this.journal.write('error', account.id, `Daily loss limit reached — new entries halted until tomorrow`);
        this.publish();
      }
      return;
    }
    if (this.config.maxDailyTrades !== null && this.counters.dailyTrades >= this.config.maxDailyTrades) {
      if (!this.haltReason) {
        this.haltReason = 'daily trade cap reached';
        this.journal.write('warn', account.id, 'Daily trade cap reached — new entries halted');
        this.publish();
      }
      return;
    }

    // 4. Signal.
    const signal = this.strategy.evaluate(this.config, tick);
    this.counters.signalsEvaluated += 1;
    this.lastSignal = signal;

    // 5. Zero-loss recovery has priority over fresh entries.
    const fired = await this.tryRecovery(account, signal);
    if (fired) return;

    // 6. Fresh entries.
    await this.tryEntries(account, signal, tick);
  }

  /** Closes the whole bot basket once its combined float clears the target. */
  private async manageBasket(account: TradingAccount): Promise<void> {
    const legs = account.listPositions().filter((p) => BOT_ORIGINS.has(p.origin));
    if (legs.length === 0) return;
    const floating = round(legs.reduce((sum, p) => sum + p.profit, 0));

    if (this.config.basketTakeProfitUsd !== null && floating >= this.config.basketTakeProfitUsd) {
      account.closeAll('basket-tp', (p) => BOT_ORIGINS.has(p.origin));
      this.journal.write('success', account.id, `Basket target hit — ${legs.length} leg(s) closed for +${floating.toFixed(2)}`);
      return;
    }
    if (this.config.basketStopLossUsd !== null && floating <= -Math.abs(this.config.basketStopLossUsd)) {
      account.closeAll('basket-sl', (p) => BOT_ORIGINS.has(p.origin));
      this.journal.write('error', account.id, `Basket stop hit — ${legs.length} leg(s) closed for ${floating.toFixed(2)}`);
    }
  }

  private botPositions(account: TradingAccount): Position[] {
    return account.listPositions().filter((p) => BOT_ORIGINS.has(p.origin) && p.symbol === this.config.symbol);
  }

  /** Remaining room under both the global and per-direction caps. */
  private capacityFor(account: TradingAccount, side: Side): number {
    const open = this.botPositions(account);
    const global = this.config.maxConcurrentPositions - open.length;
    const directional = this.config.maxPositionsPerDirection - open.filter((p) => p.side === side).length;
    return Math.max(0, Math.min(global, directional));
  }

  private async tryRecovery(account: TradingAccount, signal: Signal): Promise<boolean> {
    // One recovery works the deficit at a time — releasing the next layer while
    // the previous legs are still live would stack several attempts on the same
    // loss instead of postponing until the outcome is known.
    if (account.listPositions().some((p) => p.origin === 'recovery')) return false;

    const recovery = this.recoveryFor(account.id);
    const plan = recovery.plan(account.id, this.config, signal);
    this.emit('recoveries', this.listRecoveries());
    if (!plan) return false;

    const capacity = this.capacityFor(account, plan.side);
    if (capacity <= 0) return false;

    const legs = Math.min(plan.legs, capacity);
    const spec = getSymbolSpec(this.config.symbol);
    let opened = 0;

    for (let i = 0; i < legs; i += 1) {
      const result = await account.submit({
        symbol: this.config.symbol,
        side: plan.side,
        volume: plan.legVolume,
        stopLossUsd: null,
        takeProfitUsd: round(
          (plan.legVolume / this.config.lotSize) * this.config.takeProfitUsd,
        ),
        origin: 'recovery',
        comment: `recovery L${plan.task.layer + 1}`,
        basketIndex: i,
        recoveryLayer: plan.task.layer,
      });
      if (!result.ok) {
        this.journal.write('error', account.id, `Recovery leg rejected: ${result.error}`);
        break;
      }
      opened += 1;
      this.counters.tradesOpened += 1;
      this.counters.dailyTrades += 1;
    }

    if (opened === 0) return false;
    recovery.markFired(plan);
    this.journal.write(
      'trade',
      account.id,
      `Zero-loss recovery released — ${opened} × ${plan.legVolume.toFixed(2)} ${plan.side.toUpperCase()} ${spec.symbol}, clears ${plan.task.deficit.toFixed(2)} with +${plan.projectedNet.toFixed(2)} projected`,
    );
    this.emit('recoveries', this.listRecoveries());
    this.publish();
    return true;
  }

  private async tryEntries(account: TradingAccount, signal: Signal, tick: Tick): Promise<void> {
    if (!signal.side || signal.strength < this.config.minSignalStrength) return;
    if (tick.time - this.lastBurstAt < this.config.signalCooldownMs) return;

    const recovery = this.recoveryFor(account.id);
    if (this.config.zeroLoss.enabled && recovery.pendingDeficit > this.config.zeroLoss.maxDeficitUsd) {
      return;
    }

    const side = signal.side;
    const open = this.botPositions(account);

    if (!this.config.allowHedging && open.some((p) => p.side !== side)) return;

    // Stacked entries must keep their distance so the basket is not a single
    // price point wearing several tickets.
    if (this.config.entrySpacingUsd > 0) {
      const reference = side === 'buy' ? tick.ask : tick.bid;
      const tooClose = open
        .filter((p) => p.side === side)
        .some((p) => Math.abs(p.openPrice - reference) < this.config.entrySpacingUsd);
      if (tooClose) return;
    }

    const capacity = this.capacityFor(account, side);
    if (capacity <= 0) return;

    const legs = Math.min(this.config.entriesPerSignal, capacity);
    const opened: Position[] = [];

    for (let i = 0; i < legs; i += 1) {
      const result = await account.submit({
        symbol: this.config.symbol,
        side,
        volume: this.config.lotSize,
        stopLossUsd: this.config.stopLossUsd,
        takeProfitUsd: this.config.takeProfitUsd,
        origin: 'bot',
        comment: `${this.config.strategy} L${i + 1}`,
        basketIndex: i,
      });
      if (!result.ok) {
        this.journal.write('warn', account.id, `Entry rejected: ${result.error}`);
        break;
      }
      opened.push(result.position);
      this.counters.tradesOpened += 1;
      this.counters.dailyTrades += 1;
    }

    if (opened.length === 0) return;
    this.lastBurstAt = tick.time;

    const first = opened[0]!;
    this.journal.write(
      'trade',
      account.id,
      `${side.toUpperCase()} ${opened.length} × ${this.config.lotSize.toFixed(2)} ${this.config.symbol} @ ${first.openPrice.toFixed(2)} — ${signal.reason} (${(signal.strength * 100).toFixed(0)}%), ${this.botPositions(account).length}/${this.config.maxConcurrentPositions} open`,
    );
    this.publish();
  }

  /** Manual order entry shares the same multi-leg path as the bot. */
  async manualOrder(
    account: TradingAccount,
    params: { symbol: string; side: Side; volume: number; legs: number; stopLossUsd: number | null; takeProfitUsd: number | null; comment?: string },
  ): Promise<{ opened: Position[]; errors: string[] }> {
    const opened: Position[] = [];
    const errors: string[] = [];
    const legs = Math.max(1, Math.min(params.legs, 50));

    for (let i = 0; i < legs; i += 1) {
      const result = await account.submit({
        symbol: params.symbol,
        side: params.side,
        volume: params.volume,
        stopLossUsd: params.stopLossUsd,
        takeProfitUsd: params.takeProfitUsd,
        origin: 'manual',
        comment: params.comment ?? 'manual',
        basketIndex: i,
      });
      if (result.ok) opened.push(result.position);
      else errors.push(result.error);
    }

    if (opened.length > 0) {
      const first = opened[0]!;
      this.journal.write(
        'trade',
        account.id,
        `Manual ${params.side.toUpperCase()} ${opened.length} × ${params.volume.toFixed(2)} ${params.symbol} @ ${first.openPrice.toFixed(2)}`,
      );
    }
    for (const error of errors) this.journal.write('error', account.id, `Manual order rejected: ${error}`);
    return { opened, errors };
  }
}
