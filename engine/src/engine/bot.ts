import { Emitter } from '../emitter.js';
import {
  DEFAULT_BOT_CONFIG,
  burstSize,
  type Candle,
  getSymbolSpec,
  riskSizedLeg,
  roundPrice,
  type BotConfig,
  type BotStats,
  type AiReading,
  type AiRegime,
  type ClosedTrade,
  type Position,
  type Side,
  type Signal,
  type Tick,
} from '@sentinal/shared';
import { BUILTIN_MAGIC, type OpenRequest, type OpenResult, type TradingAccount } from '../broker/account.js';
import type { AccountManager } from '../broker/manager.js';
import type { Journal } from '../journal.js';
import { round, startOfDay } from '../util.js';
import { MarketBrain, type TradeLesson } from './ai/brain.js';
import type { CopyTradeEngine } from './copier.js';
import type { ExpertBank } from './bank.js';
import { RecoveryEngine } from './recovery.js';
import { StrategyEngine, TrendTracker } from './strategy.js';

/** Positions the bot itself is responsible for (copies belong to the copier). */
const BOT_ORIGINS = new Set(['bot', 'recovery']);

/** Comment prefix of the AI's own positions. */
const AI_TAG = 'AI';

/** What the AI remembers about a trade it opened, to manage it and learn from it. */
interface AiTradeMeta {
  side: Side;
  entry: number;
  /** Price distance to the initial stop: one R. */
  risk: number;
  atr: number;
  regime: AiRegime;
  probability: number;
  lastModifyAt: number;
  /** A close has been sent; it is not sent again. */
  closing?: boolean;
}

/** Stop distance by kind of market: wider where it trends or swings hard. */
const REGIME_STOP: Record<AiRegime, number> = {
  'trend-up': 1.2,
  'trend-down': 1.2,
  range: 0.9,
  volatile: 1.4,
  quiet: 1,
};

export class BotEngine extends Emitter {
  config: BotConfig = {
    ...DEFAULT_BOT_CONFIG,
    zeroLoss: { ...DEFAULT_BOT_CONFIG.zeroLoss },
    dispatch: { ...DEFAULT_BOT_CONFIG.dispatch },
    burst: { ...DEFAULT_BOT_CONFIG.burst },
    ai: { ...DEFAULT_BOT_CONFIG.ai, claude: { ...DEFAULT_BOT_CONFIG.ai.claude } },
  };
  /** Sends orders to the master and every follower at once, when wired. */
  private dispatcher: CopyTradeEngine | null = null;
  /** The EA library: every EA switched on runs beside the built-in model. */
  private experts: ExpertBank | null = null;
  /** Positions the EAs opened, so their results never feed the built-in models' recovery. */
  private readonly eaPositions = new Set<string>();
  /** Trades an .ex5 makes in MetaTrader are copied while one is switched on. */
  private mirroring = false;
  private readonly strategy = new StrategyEngine();
  private readonly trend = new TrendTracker();
  /** The AI: reads the market on every quote, whatever is trading. */
  readonly brain = new MarketBrain();
  /** Claude may pause the AI's entries until this time (ms), or 0. */
  aiPausedUntil = 0;
  private readonly aiTrades = new Map<string, AiTradeMeta>();
  private aiNextEntryAt = 0;
  private aiWarnedAt = 0;
  private dayOpenBalance: number | null = null;
  private aiDayHalted = false;
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
  private warnedMinLot = false;
  /* Burst model state. */
  private burstOpen = false;
  private burstClosedAt = 0;
  private burstRetryAt = 0;
  private burstTooSmallWarned = false;

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
    this.accounts.on('closed', (trade: ClosedTrade, position: Position) => this.onTradeClosed(trade, position));
    // Trades an .ex5 makes in MetaTrader count toward the daily guards too.
    this.accounts.on('opened', (position: Position, account: TradingAccount) => {
      if (!this.running || !this.mirroring || account !== this.accounts.primary() || position.origin !== 'external') return;
      this.countOpened();
    });
  }

  private countOpened(): void {
    this.counters.tradesOpened += 1;
    this.counters.dailyTrades += 1;
    this.publish();
  }

  setDispatcher(dispatcher: CopyTradeEngine | null): void {
    this.dispatcher = dispatcher;
    if (dispatcher) dispatcher.config = this.config.dispatch;
  }

  setExpertBank(bank: ExpertBank | null): void {
    this.experts = bank;
    if (!bank) return;
    bank.entryGuard = (side) => this.aiGuard(side);
    // Every EA's fills count toward the daily guards.
    bank.on('opened', (position: Position) => {
      this.eaPositions.add(position.id);
      if (this.running) this.countOpened();
    });
    // An .ex5 switched on or off while running starts or stops the mirroring.
    bank.on('mirror-changed', () => {
      if (this.running) this.setMirroring(bank.enabledSource().mirrored.length > 0);
    });
  }

  private setMirroring(on: boolean): void {
    this.mirroring = on;
    if (this.dispatcher) this.dispatcher.mirrorExternal = on;
  }

  /** Entries the AI's guard has refused, and the last reason. */
  readonly guard = { vetoes: 0, last: null as string | null, lastAt: null as number | null };

  /**
   * The AI's say over an EA's new entry: refused when the market reads as
   * dangerous, or when the AI gives the other side a firm probability.
   */
  aiGuard(side: Side): string | null {
    const cfg = this.config.ai;
    if (!cfg.guardEas) return null;
    const r = this.brain.read(cfg.minProbability);
    if (!r.ready) return null;
    let reason: string | null = null;
    if (r.danger.level >= cfg.guardDanger) {
      reason = r.danger.reasons.join(', ') || 'the market reads as dangerous';
    } else {
      const against = side === 'buy' ? 1 - r.probabilityUp : r.probabilityUp;
      if (against >= cfg.guardAgainst) reason = `the AI gives ${side === 'buy' ? 'SELL' : 'BUY'} ${(against * 100).toFixed(0)}% (${r.regime})`;
    }
    if (reason) {
      this.guard.vetoes += 1;
      this.guard.last = reason;
      this.guard.lastAt = r.time;
    }
    return reason;
  }

  /** One order out: through the dispatcher when there is one, straight to the account otherwise. */
  private submit(account: TradingAccount, req: OpenRequest): Promise<OpenResult> {
    return this.dispatcher ? this.dispatcher.open(account, req) : account.submit(req);
  }

  /** Closes the matching bot legs, each with its copies, all at once. */
  private closeLegs(account: TradingAccount, reason: ClosedTrade['reason'], filter: (p: Position) => boolean): number {
    const legs = account.listPositions().filter(filter);
    if (!this.dispatcher) return account.requestCloseAll(reason, filter);
    for (const leg of legs) void this.dispatcher.close(account, leg.id, reason);
    return legs.length;
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
    this.trend.prime(candles);
    this.brain.prime(candles);
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
    const followers = this.accounts.slavesOf(account.id).length;
    const copyNote = followers > 0 ? ` · mirroring to ${followers} follower(s), ${this.config.dispatch.mode}` : '';

    const bank = this.experts;
    const eas = bank?.enabledSource() ?? { engine: [], mirrored: [] };
    const builtin = this.config.strategy !== 'none';
    if (!builtin && eas.engine.length === 0 && eas.mirrored.length === 0) {
      this.running = false;
      this.config.enabled = false;
      this.journal.write('error', account.id, 'Nothing to run: pick Burst or the AI, or switch on an EA in the library.');
      this.publish();
      return;
    }
    if (bank) bank.tradingAllowed = true;
    if (eas.engine.length > 0 && bank) {
      this.journal.write('success', account.id, `EAs starting on ${account.symbol}: ${eas.engine.join(', ')}${copyNote}`);
      void bank.startAll(account);
    }
    this.setMirroring(eas.mirrored.length > 0);
    if (eas.mirrored.length > 0) {
      this.journal.write(
        'success',
        account.id,
        `Mirroring ${eas.mirrored.join(', ')} — every position it opens in MetaTrader on ${account.config.name} is copied${copyNote}`,
      );
    }
    if (!builtin) {
      // The EAs alone trade.
    } else if (this.config.strategy === 'ai') {
      const a = this.config.ai;
      const reading = this.brain.read(a.minProbability);
      this.aiNextEntryAt = 0;
      this.journal.write(
        'success',
        account.id,
        `Bot started — the AI trades ${this.config.symbol} when it gives a move at least ${(a.minProbability * 100).toFixed(0)}% ` +
          `(${reading.ready ? `now ${AI_TAG} reads ${reading.regime}` : reading.warmup ?? 'warming up'}), risking ${a.riskPercent}% per trade, ` +
          `stop ${a.slAtr} ATR, target ${a.rrMin}–${a.rrMax}R${copyNote}`,
      );
    } else if (this.config.strategy === 'burst') {
      const b = this.config.burst;
      const count = burstSize(account.balance, b.positionsPerStep, b.balanceStep, b.maxPositions);
      this.burstOpen = this.botPositions(account).length > 0;
      this.burstRetryAt = 0;
      this.journal.write(
        'success',
        account.id,
        `Bot started — burst mode on ${this.config.symbol}: ${count} × ${b.lot.toFixed(2)} per burst at ${account.balance.toFixed(2)} balance, ` +
          `take profit +${b.takeProfitPrice.toFixed(2)}${b.stopLossPrice ? `, stop ${b.stopLossPrice.toFixed(2)}` : ', no stop loss'}, ` +
          `${b.direction === 'ai' ? 'in the direction the AI gives' : b.direction === 'trend' ? 'following the trend' : `${b.direction.toUpperCase()} only`}${copyNote}`,
      );
    } else {
      this.journal.write(
        'success',
        account.id,
        `Bot armed on ${this.config.symbol} — ${this.config.strategy}, ${this.config.entriesPerSignal} leg(s)/signal, up to ${this.config.maxConcurrentPositions} concurrent${copyNote}`,
      );
    }
    this.publish();
  }

  stop(closePositions = false): void {
    if (!this.running && !closePositions) return;
    this.running = false;
    this.config.enabled = false;
    if (this.experts) void this.experts.stopAll();
    this.setMirroring(false);
    if (closePositions) {
      const primary = this.accounts.primary();
      for (const account of this.accounts.list()) {
        // Copies close with their master; followers are flattened directly only for legs without one.
        const filter = (p: Position) => BOT_ORIGINS.has(p.origin) || (p.origin === 'copy' && !p.sourceId);
        const count = account === primary ? this.closeLegs(account, 'bot-stop', filter) : account.requestCloseAll('bot-stop', filter);
        if (count > 0) {
          this.journal.write('warn', account.id, `Flattened ${count} bot position(s) on stop`);
        }
      }
    }
    this.journal.write('info', null, 'Bot disarmed');
    this.publish();
  }

  updateConfig(patch: Partial<BotConfig>): BotConfig {
    const previouslyEnabled = this.config.enabled;
    const modelChanged = patch.strategy !== undefined && patch.strategy !== this.config.strategy;
    this.config = {
      ...this.config,
      ...patch,
      zeroLoss: { ...this.config.zeroLoss, ...(patch.zeroLoss ?? {}) },
      dispatch: { ...this.config.dispatch, ...(patch.dispatch ?? {}) },
      burst: { ...this.config.burst, ...(patch.burst ?? {}) },
      ai: {
        ...this.config.ai,
        ...(patch.ai ?? {}),
        claude: { ...this.config.ai.claude, ...(patch.ai?.claude ?? {}) },
      },
    };
    this.brain.configure({ horizonBars: this.config.ai.horizonBars, learningRate: this.config.ai.learningRate });
    if (this.dispatcher) this.dispatcher.config = this.config.dispatch;
    // A different built-in model never inherits a running one: disarm, then arm again.
    if (modelChanged && this.running) {
      this.stop();
      this.journal.write('warn', null, 'Built-in model changed — the bot was disarmed; arm it again to start the new one.');
      return this.config;
    }
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

  private onTradeClosed(trade: ClosedTrade, position?: Position): void {
    const counted = BOT_ORIGINS.has(trade.origin) || (this.mirroring && trade.origin === 'external');
    if (!counted || trade.accountId !== this.accounts.primary()?.id) return;
    // An AI trade is a lesson: its result in R, in the kind of market it was taken in.
    const meta = position ? this.aiTrades.get(position.id) : undefined;
    if (meta || trade.comment.startsWith(`${AI_TAG} `)) {
      if (position) this.aiTrades.delete(position.id);
      const dir = trade.side === 'buy' ? 1 : -1;
      const risk = meta?.risk ?? Math.abs(trade.openPrice - (position?.stopLoss ?? trade.openPrice));
      if (risk > 0) {
        const lesson: TradeLesson = { regime: meta?.regime ?? 'range', side: trade.side, r: round(((trade.closePrice - trade.openPrice) * dir) / risk, 2) };
        this.brain.recordTrade(lesson);
        this.emit('ai-trade', { ...lesson, netProfit: trade.netProfit, probability: meta?.probability ?? null, ticket: trade.ticket });
      }
      // After a loss the AI waits three bars before its next entry; after a win, one.
      const pause = trade.netProfit < 0 ? 180_000 : 60_000;
      this.aiNextEntryAt = Math.max(this.aiNextEntryAt, trade.closeTime + pause);
    }
    this.counters.tradesClosed += 1;
    this.counters.dailyProfit = round(this.counters.dailyProfit + trade.netProfit);
    if (trade.netProfit >= 0) {
      this.counters.wins += 1;
      this.counters.grossProfit = round(this.counters.grossProfit + trade.netProfit);
    } else {
      this.counters.losses += 1;
      this.counters.grossLoss = round(this.counters.grossLoss + Math.abs(trade.netProfit));
    }

    // Recovery pooling belongs to the signal models' own trades; an EA, the
    // AI, or a burst with its own take profit manages its own exits.
    const fromEa = position ? this.eaPositions.delete(position.id) : false;
    if (fromEa || trade.origin === 'external' || ['burst', 'ai', 'none'].includes(this.config.strategy)) {
      this.publish();
      return;
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
    this.trend.update(tick);
    // The AI learns from every quote, whether or not it is the one trading.
    this.brain.update(tick);
    if (!this.running) return;

    if (this.experts && this.experts.size > 0) {
      this.rollDay(tick.time);
      // The daily guards stop the EAs' new orders the way AutoTrading off would.
      this.experts.tradingAllowed = !this.guardsTripped();
      this.experts.onTick(tick);
    }
    if (this.config.strategy === 'none') return;

    if (this.busy) return;

    this.busy = true;
    try {
      await this.evaluate(tick, barClosed);
    } catch (err) {
      this.journal.write('error', null, `Engine error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.busy = false;
    }
  }

  /**
   * The daily circuit breakers as a safety net over an EA: once tripped, the
   * EA's orders are refused the way MetaTrader refuses them with AutoTrading
   * off, until the next trading day.
   */
  private guardsTripped(): boolean {
    if (this.config.maxDailyLossUsd !== null && this.counters.dailyProfit <= -this.config.maxDailyLossUsd) {
      if (!this.haltReason) {
        this.haltReason = `daily loss limit hit (${this.counters.dailyProfit.toFixed(2)})`;
        this.journal.write('error', null, 'Daily loss limit reached — the expert may manage open trades but cannot open new ones until tomorrow');
        this.publish();
      }
      return true;
    }
    if (this.config.maxDailyTrades !== null && this.counters.dailyTrades >= this.config.maxDailyTrades) {
      if (!this.haltReason) {
        this.haltReason = 'daily trade cap reached';
        this.journal.write('warn', null, 'Daily trade cap reached — the expert\'s new orders are blocked until tomorrow');
        this.publish();
      }
      return true;
    }
    return false;
  }

  private rollDay(now: number): void {
    const today = startOfDay(now);
    if (this.dayOpenBalance === null) this.dayOpenBalance = this.accounts.primary()?.balance ?? null;
    if (today === this.dayStamp) return;
    this.dayStamp = today;
    this.dayOpenBalance = this.accounts.primary()?.balance ?? null;
    this.aiDayHalted = false;
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

    // The burst model keeps its own exits (a take profit on every position)
    // and acts on every quote.
    if (this.config.strategy === 'burst') {
      await this.evaluateBurst(account, tick);
      return;
    }
    if (this.config.strategy === 'ai') {
      await this.evaluateAi(account, tick);
      return;
    }

    // 1. Basket management runs on every tick regardless of execution mode.
    await this.manageBasket(account);

    // 2. Timing gate.
    if (this.config.execution === 'bar-close') {
      if (!barClosed || this.lastBarTime === tick.time) return;
      this.lastBarTime = tick.time;
    }

    if (this.entryBlocked(account, tick)) return;

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

  /** The spread and daily guards; true when no new position may open now. */
  private entryBlocked(account: TradingAccount, tick: Tick): boolean {
    const spread = round(tick.ask - tick.bid);
    if (spread > this.config.maxSpread) {
      if (tick.time - this.spreadWarnedAt > 30_000) {
        this.spreadWarnedAt = tick.time;
        this.journal.write('warn', account.id, `Spread ${spread.toFixed(2)} above limit ${this.config.maxSpread.toFixed(2)} — entries paused`);
      }
      return true;
    }
    if (this.config.maxDailyLossUsd !== null && this.counters.dailyProfit <= -this.config.maxDailyLossUsd) {
      if (!this.haltReason) {
        this.haltReason = `daily loss limit hit (${this.counters.dailyProfit.toFixed(2)})`;
        this.journal.write('error', account.id, `Daily loss limit reached — new entries halted until tomorrow`);
        this.publish();
      }
      return true;
    }
    if (this.config.maxDailyTrades !== null && this.counters.dailyTrades >= this.config.maxDailyTrades) {
      if (!this.haltReason) {
        this.haltReason = 'daily trade cap reached';
        this.journal.write('warn', account.id, 'Daily trade cap reached — new entries halted');
        this.publish();
      }
      return true;
    }
    return false;
  }

  /**
   * One burst at a time: while any of its positions is open the bot waits
   * (each carries its own take profit at the broker); once the last has
   * closed, the next burst goes out at once in the trend's direction, sized
   * from the balance as it now stands.
   */
  private async evaluateBurst(account: TradingAccount, tick: Tick): Promise<void> {
    const cfg = this.config.burst;
    const open = this.botPositions(account);
    const reading = this.trend.read(cfg.trendTimeframeMin, cfg.trendFastPeriod, cfg.trendSlowPeriod);
    const pick = cfg.direction === 'ai' ? this.aiBurstDirection(reading.side, reading.reason, tick.time) : null;
    const side: Side | null = pick ? pick.side : cfg.direction === 'trend' ? reading.side : cfg.direction === 'ai' ? null : cfg.direction;
    this.counters.signalsEvaluated += 1;
    this.lastSignal = {
      time: tick.time,
      symbol: this.config.symbol,
      side,
      strength: side ? 1 : 0,
      fast: reading.fast,
      slow: reading.slow,
      momentum: 0,
      volatility: 0,
      reason:
        open.length > 0
          ? `burst open — ${open.length} position(s) riding to +${cfg.takeProfitPrice.toFixed(2)}`
          : pick
            ? pick.reason
            : cfg.direction === 'trend'
              ? reading.reason
              : `${cfg.direction.toUpperCase()} only`,
    };

    if (open.length > 0) {
      this.burstOpen = true;
      return;
    }
    if (this.burstOpen) {
      this.burstOpen = false;
      this.burstClosedAt = tick.time;
      this.journal.write('success', account.id, `Burst closed — balance now ${account.balance.toFixed(2)}`);
      this.publish();
    }
    if (tick.time < this.burstRetryAt || tick.time - this.burstClosedAt < cfg.reentryDelayMs) return;
    if (this.entryBlocked(account, tick)) return;
    if (!side) return;

    const count = burstSize(account.balance, cfg.positionsPerStep, cfg.balanceStep, cfg.maxPositions);
    if (count < 1) {
      if (!this.burstTooSmallWarned) {
        this.burstTooSmallWarned = true;
        this.journal.write('warn', account.id, `Balance ${account.balance.toFixed(2)} is below one position's step — no burst opened`);
      }
      return;
    }
    this.burstTooSmallWarned = false;

    const spec = account.spec(this.config.symbol);
    const entry = side === 'buy' ? tick.ask : tick.bid;
    const dir = side === 'buy' ? 1 : -1;
    const takeProfit = roundPrice(spec, entry + dir * cfg.takeProfitPrice);
    const stopLoss = cfg.stopLossPrice && cfg.stopLossPrice > 0 ? roundPrice(spec, entry - dir * cfg.stopLossPrice) : null;
    const comment = `${cfg.comment} ${side.toUpperCase()}`.trim();

    // Every position of the burst leaves at once.
    const results = await Promise.all(
      Array.from({ length: count }, (_, i) =>
        this.submit(account, {
          symbol: this.config.symbol,
          side,
          volume: cfg.lot,
          stopLoss,
          takeProfit,
          stopLossUsd: null,
          takeProfitUsd: null,
          origin: 'bot',
          magic: BUILTIN_MAGIC,
          comment,
          basketIndex: i,
          burst: { index: i, perStep: cfg.positionsPerStep, step: cfg.balanceStep, max: cfg.maxPositions },
        }),
      ),
    );

    let opened = 0;
    let firstPrice: number | null = null;
    let rejected: string | null = null;
    for (const result of results) {
      if (!result.ok) {
        rejected = result.error;
        continue;
      }
      opened += 1;
      firstPrice ??= result.position.openPrice;
      this.counters.tradesOpened += 1;
      this.counters.dailyTrades += 1;
    }
    if (rejected) this.journal.write('warn', account.id, `${count - opened} of ${count} burst position(s) rejected: ${rejected}`);
    if (opened === 0) {
      // Nothing filled: try again shortly rather than on every quote.
      this.burstRetryAt = tick.time + 5_000;
      this.publish();
      return;
    }
    this.burstOpen = true;
    this.journal.write(
      'trade',
      account.id,
      `BURST ${side.toUpperCase()} ${opened} × ${cfg.lot.toFixed(2)} ${this.config.symbol} @ ${(firstPrice ?? entry).toFixed(spec.digits)} → TP ${takeProfit.toFixed(spec.digits)}` +
        `${stopLoss !== null ? `, SL ${stopLoss.toFixed(spec.digits)}` : ''} (balance ${account.balance.toFixed(2)})`,
    );
    this.publish();
  }

  /* --------------------------------------------------------------- */
  /* The AI's own trades                                              */
  /* --------------------------------------------------------------- */

  /** The AI's open positions on the master. */
  private aiPositions(account: TradingAccount): Position[] {
    return this.botPositions(account).filter((p) => p.comment.startsWith(`${AI_TAG} `));
  }

  /** Throttled journal line, so a condition that holds for minutes is said once a minute. */
  private aiNote(account: TradingAccount, now: number, level: 'info' | 'warn', message: string): void {
    if (now - this.aiWarnedAt < 60_000) return;
    this.aiWarnedAt = now;
    this.journal.write(level, account.id, message);
  }

  /**
   * One decision per quote: manage what is open, then look for an entry.
   * An entry needs the AI warmed up, its calibrated probability at or above
   * the threshold it currently asks for (which rises after losses and in
   * regimes that have been losing), a market that is not dangerous, room
   * under the position cap, and the pause after the last trade served.
   */
  private async evaluateAi(account: TradingAccount, tick: Tick): Promise<void> {
    const cfg = this.config.ai;
    const reading = this.brain.read(cfg.minProbability, tick.time);
    this.counters.signalsEvaluated += 1;
    const pUp = reading.probabilityUp;
    const side: Side = pUp >= 0.5 ? 'buy' : 'sell';
    const pSide = Math.max(pUp, 1 - pUp);
    this.lastSignal = {
      time: tick.time,
      symbol: this.config.symbol,
      side: reading.side,
      strength: reading.confidence,
      fast: reading.ensemble,
      slow: pUp,
      momentum: reading.adx,
      volatility: reading.atr,
      reason: reading.ready
        ? `${side.toUpperCase()} ${(pSide * 100).toFixed(0)}% (needs ${(reading.threshold * 100).toFixed(0)}%) — ${reading.reasons[0] ?? reading.regime}`
        : reading.warmup ?? 'warming up',
    };

    await this.manageAiPositions(account, tick, reading);

    if (!reading.ready || reading.atr <= 0) return;
    if (tick.time < this.aiPausedUntil) return;
    if (tick.time < this.aiNextEntryAt) return;
    if (this.entryBlocked(account, tick)) return;

    // The AI's own daily loss limit, a share of the day's opening balance.
    const limit = ((this.dayOpenBalance ?? account.balance) * cfg.dailyLossPercent) / 100;
    if (cfg.dailyLossPercent > 0 && this.counters.dailyProfit <= -limit) {
      if (!this.aiDayHalted) {
        this.aiDayHalted = true;
        this.journal.write('error', account.id, `AI daily loss limit reached (${this.counters.dailyProfit.toFixed(2)}) — no new AI trades until tomorrow`);
        this.publish();
      }
      return;
    }
    if (reading.regime === 'volatile' && !cfg.tradeVolatile) return;
    if (reading.danger.level >= cfg.guardDanger) {
      this.aiNote(account, tick.time, 'warn', `AI holding off — ${reading.danger.reasons.join(', ') || 'market reads as dangerous'}`);
      return;
    }
    if (pSide < reading.threshold) return;

    const open = this.aiPositions(account);
    if (open.length >= Math.max(1, Math.round(cfg.maxPositions))) return;
    // It adds only in the direction it already holds, and never on top of its last entry.
    if (open.some((p) => p.side !== side)) return;
    const entry = side === 'buy' ? tick.ask : tick.bid;
    if (open.some((p) => Math.abs(p.openPrice - entry) < reading.atr)) return;

    // Stop from volatility and the kind of market; target from confidence.
    const spec = account.spec(this.config.symbol);
    const spread = Math.max(0, tick.ask - tick.bid);
    const stopDistance = Math.max(cfg.slAtr * reading.atr * REGIME_STOP[reading.regime], 3 * spread, spec.tickSize * 10);
    const edge = Math.max(0, Math.min(1, (pSide - reading.threshold) / Math.max(0.01, 0.95 - reading.threshold)));
    let rr = cfg.rrMin + (cfg.rrMax - cfg.rrMin) * edge;
    // A range seldom pays a long way: its targets stay modest.
    if (reading.regime === 'range' || reading.regime === 'quiet') rr = Math.min(rr, Math.max(cfg.rrMin, 1.8));
    const dir = side === 'buy' ? 1 : -1;
    const stopLoss = roundPrice(spec, entry - dir * stopDistance);
    const takeProfit = roundPrice(spec, entry + dir * stopDistance * rr);

    // Size from the risk: the stop costs riskPercent of equity, never more than the cap.
    const riskPercent = Math.min(cfg.riskPercent, cfg.maxRiskPercent);
    const sized = riskSizedLeg(spec, account.equity(), riskPercent, stopDistance, rr);
    const riskShare = account.equity() > 0 ? (sized.riskUsd / account.equity()) * 100 : Infinity;
    if (sized.minLotExceedsRisk && riskShare > cfg.maxRiskPercent) {
      this.aiNote(
        account,
        tick.time,
        'warn',
        `AI skipped a ${side.toUpperCase()}: the broker's minimum ${spec.minLot} lot would risk ${riskShare.toFixed(1)}% of equity at a ` +
          `${stopDistance.toFixed(2)} stop, above the ${cfg.maxRiskPercent}% cap`,
      );
      this.aiNextEntryAt = tick.time + 60_000;
      return;
    }

    const result = await this.submit(account, {
      symbol: this.config.symbol,
      side,
      volume: sized.volume,
      stopLoss,
      takeProfit,
      stopLossUsd: null,
      takeProfitUsd: null,
      origin: 'bot',
      magic: BUILTIN_MAGIC,
      comment: `${AI_TAG} ${side.toUpperCase()}`,
    });
    if (!result.ok) {
      this.journal.write('warn', account.id, `AI entry rejected: ${result.error}`);
      this.aiNextEntryAt = tick.time + 5_000;
      return;
    }
    const position = result.position;
    this.aiTrades.set(position.id, {
      side,
      entry: position.openPrice,
      risk: Math.abs(position.openPrice - stopLoss),
      atr: reading.atr,
      regime: reading.regime,
      probability: pSide,
      lastModifyAt: tick.time,
    });
    this.counters.tradesOpened += 1;
    this.counters.dailyTrades += 1;
    this.aiNextEntryAt = tick.time + 60_000;
    this.journal.write(
      'trade',
      account.id,
      `AI ${side.toUpperCase()} ${sized.volume.toFixed(2)} ${this.config.symbol} @ ${position.openPrice.toFixed(spec.digits)} — ` +
        `${(pSide * 100).toFixed(0)}% in a ${reading.regime} market, SL ${stopLoss.toFixed(spec.digits)} (${stopDistance.toFixed(2)}), ` +
        `TP ${takeProfit.toFixed(spec.digits)} (${rr.toFixed(1)}R), risking ${sized.riskUsd.toFixed(2)}` +
        `${reading.reasons[1] ? ` · ${reading.reasons[1]}` : ''}`,
    );
    this.publish();
  }

  /**
   * Looks after each open AI trade: to break-even once it has run far
   * enough, then a trailing stop, both moved at the broker (and on every
   * copy); and out altogether if the AI turns firmly against it before it
   * is safely in profit.
   */
  private async manageAiPositions(account: TradingAccount, tick: Tick, reading: AiReading): Promise<void> {
    const cfg = this.config.ai;
    const spec = account.spec(this.config.symbol);
    const spread = Math.max(0, tick.ask - tick.bid);
    for (const position of this.aiPositions(account)) {
      let meta = this.aiTrades.get(position.id);
      if (!meta) {
        // Opened before a reload: rebuild what can be rebuilt from the position.
        const risk = position.stopLoss ? Math.abs(position.openPrice - position.stopLoss) : reading.atr * cfg.slAtr;
        meta = { side: position.side, entry: position.openPrice, risk, atr: reading.atr || risk / cfg.slAtr, regime: reading.regime, probability: 0.5, lastModifyAt: 0 };
        this.aiTrades.set(position.id, meta);
      }
      const dir = position.side === 'buy' ? 1 : -1;
      const price = position.side === 'buy' ? tick.bid : tick.ask;
      const gained = (price - position.openPrice) * dir;
      const atrNow = reading.atr > 0 ? reading.atr : meta.atr;

      if (meta.closing) continue;
      if (cfg.exitOnFlip && reading.ready) {
        const against = position.side === 'buy' ? 1 - reading.probabilityUp : reading.probabilityUp;
        if (against >= Math.max(reading.threshold, 0.62) && gained < 0.5 * meta.atr) {
          // The record stays until the close is booked: the lesson needs it.
          meta.closing = true;
          void (this.dispatcher ? this.dispatcher.close(account, position.id, 'ai-exit') : account.submitClose(position.id, 'ai-exit'));
          this.journal.write(
            'warn',
            account.id,
            `AI closed #${position.ticket}: it now gives the other side ${(against * 100).toFixed(0)}% (${reading.regime})`,
          );
          continue;
        }
      }

      let stop = position.stopLoss;
      if (cfg.breakevenAtr > 0 && gained >= cfg.breakevenAtr * meta.atr) {
        const breakeven = position.openPrice + dir * Math.max(spread, spec.tickSize * 5);
        if (stop === null || (breakeven - stop) * dir > 0) stop = breakeven;
      }
      if (cfg.trailStartAtr > 0 && gained >= cfg.trailStartAtr * meta.atr) {
        const trail = price - dir * cfg.trailAtr * atrNow;
        if (stop === null || (trail - stop) * dir > 0) stop = trail;
      }
      if (stop === null || stop === position.stopLoss) continue;
      stop = roundPrice(spec, stop);
      const improvement = position.stopLoss === null ? Infinity : (stop - position.stopLoss) * dir;
      if (improvement < Math.max(0.1 * meta.atr, spec.tickSize * 2)) continue;
      if (tick.time - meta.lastModifyAt < 2_000) continue;
      meta.lastModifyAt = tick.time;
      void (this.dispatcher
        ? this.dispatcher.modify(account, position.id, stop, position.takeProfit)
        : account.submitModify(position.id, stop, position.takeProfit));
    }
  }

  /**
   * The AI's call for the next burst. A burst has no stop, so the AI's first
   * job is to hold one back: when the market reads as dangerous, or when the
   * AI leans against the trend, nothing goes out. When it is confident the
   * burst goes its way; when it is unsure the burst follows the trend, as it
   * does before the AI has warmed up.
   */
  private aiBurstDirection(trendSide: Side | null, trendReason: string, now: number): { side: Side | null; reason: string } {
    const cfg = this.config.ai;
    const r = this.brain.read(cfg.minProbability, now);
    if (!r.ready) return { side: trendSide, reason: `${trendReason} (AI ${r.warmup ?? 'warming up'})` };
    if (r.danger.level >= cfg.guardDanger) {
      return { side: null, reason: `AI holding the burst back — ${r.danger.reasons.join(', ') || 'market reads as dangerous'}` };
    }
    if (now < this.aiPausedUntil) return { side: null, reason: 'AI holding the burst back — paused by the review' };
    const lean: Side = r.probabilityUp >= 0.5 ? 'buy' : 'sell';
    const p = Math.max(r.probabilityUp, 1 - r.probabilityUp);
    const pct = `${(p * 100).toFixed(0)}%`;
    if (p >= r.threshold) return { side: lean, reason: `AI calls ${lean.toUpperCase()} ${pct} — ${r.reasons[1] ?? r.reasons[0] ?? r.regime}` };
    if (trendSide && lean !== trendSide && p >= 0.55) {
      return { side: null, reason: `AI expects a turn (${lean.toUpperCase()} ${pct}) against the ${trendSide === 'buy' ? 'up' : 'down'}trend — burst held back` };
    }
    return trendSide
      ? { side: trendSide, reason: `${trendReason}; the AI does not object (${lean.toUpperCase()} ${pct})` }
      : { side: null, reason: `no clear trend and no AI call (${lean.toUpperCase()} ${pct}, needs ${(r.threshold * 100).toFixed(0)}%)` };
  }

  /** Closes the whole bot basket once its combined float clears the target. */
  private async manageBasket(account: TradingAccount): Promise<void> {
    const own = new Set(this.botPositions(account).map((p) => p.id));
    const legs = account.listPositions().filter((p) => own.has(p.id));
    if (legs.length === 0) return;
    const floating = round(legs.reduce((sum, p) => sum + p.profit, 0));

    if (this.config.basketTakeProfitUsd !== null && floating >= this.config.basketTakeProfitUsd) {
      this.closeLegs(account, 'basket-tp', (p) => own.has(p.id));
      this.journal.write('success', account.id, `Basket target hit — ${legs.length} leg(s) closed for +${floating.toFixed(2)}`);
      return;
    }
    if (this.config.basketStopLossUsd !== null && floating <= -Math.abs(this.config.basketStopLossUsd)) {
      this.closeLegs(account, 'basket-sl', (p) => own.has(p.id));
      this.journal.write('error', account.id, `Basket stop hit — ${legs.length} leg(s) closed for ${floating.toFixed(2)}`);
    }
  }

  /**
   * Size and levels for one leg, from the account as it stands right now.
   *
   * In risk-percent mode a growing account trades bigger and a shrinking one
   * trades smaller, with the stop held at a fixed price distance so the money
   * risked stays the configured share of equity.
   */
  sizeLeg(account: TradingAccount): { volume: number; stopLossUsd: number; takeProfitUsd: number } {
    const spec = getSymbolSpec(this.config.symbol);
    if (this.config.sizing !== 'risk-percent') {
      return {
        volume: this.config.lotSize,
        stopLossUsd: this.config.stopLossUsd,
        takeProfitUsd: this.config.takeProfitUsd,
      };
    }

    const sized = riskSizedLeg(
      spec,
      account.equity(),
      this.config.riskPercent,
      this.config.stopDistance,
      this.config.rewardRatio,
    );

    if (sized.minLotExceedsRisk && !this.warnedMinLot) {
      this.warnedMinLot = true;
      this.journal.write(
        'warn',
        account.id,
        `Broker minimum ${spec.minLot} lot risks ${sized.riskUsd.toFixed(2)} — more than ` +
          `${this.config.riskPercent}% of ${account.equity().toFixed(2)} equity. Legs use the minimum.`,
      );
    }

    return { volume: sized.volume, stopLossUsd: sized.stopLossUsd, takeProfitUsd: sized.takeProfitUsd };
  }

  /**
   * The built-in model's own positions. EAs trade the same master, so theirs
   * are left out: the ones they opened this session, and any not carrying
   * the terminal's own magic number.
   */
  private botPositions(account: TradingAccount): Position[] {
    return account
      .listPositions()
      .filter((p) => BOT_ORIGINS.has(p.origin) && p.symbol === this.config.symbol && !this.eaPositions.has(p.id) && this.isBuiltin(p));
  }

  /** Stamped with the terminal's magic, or (opened before it was stamped) carrying a comment only the built-in models write. */
  private isBuiltin(p: Position): boolean {
    if (p.magic === BUILTIN_MAGIC) return true;
    if (p.magic !== 0) return false;
    return (
      p.comment.startsWith(`${this.config.burst.comment} `) ||
      p.comment.startsWith(`${AI_TAG} `) ||
      p.comment.startsWith('recovery') ||
      /^(adaptive-scalp|momentum|mean-reversion) L\d/.test(p.comment)
    );
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

    // Every leg of the plan goes out together rather than one broker round trip after another.
    const results = await Promise.all(
      Array.from({ length: legs }, (_, i) =>
        this.submit(account, {
          symbol: this.config.symbol,
          side: plan.side,
          volume: plan.legVolume,
          stopLossUsd: null,
          takeProfitUsd: round((plan.legVolume / this.config.lotSize) * this.config.takeProfitUsd),
          origin: 'recovery',
          magic: BUILTIN_MAGIC,
          comment: `recovery L${plan.task.layer + 1}`,
          basketIndex: i,
          recoveryLayer: plan.task.layer,
        }),
      ),
    );
    for (const result of results) {
      if (!result.ok) {
        this.journal.write('error', account.id, `Recovery leg rejected: ${result.error}`);
        continue;
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
    // Sized once per burst, from equity as it stands before the burst.
    const sizing = this.sizeLeg(account);

    // The whole burst leaves at once: N legs cost one broker round trip, not N.
    const results = await Promise.all(
      Array.from({ length: legs }, (_, i) =>
        this.submit(account, {
          symbol: this.config.symbol,
          side,
          volume: sizing.volume,
          stopLossUsd: sizing.stopLossUsd,
          takeProfitUsd: sizing.takeProfitUsd,
          origin: 'bot',
          magic: BUILTIN_MAGIC,
          comment: `${this.config.strategy} L${i + 1}`,
          basketIndex: i,
        }),
      ),
    );
    let rejected: string | null = null;
    for (const result of results) {
      if (!result.ok) {
        rejected = result.error;
        continue;
      }
      opened.push(result.position);
      this.counters.tradesOpened += 1;
      this.counters.dailyTrades += 1;
    }
    if (rejected) this.journal.write('warn', account.id, `Entry rejected: ${rejected}`);

    if (opened.length === 0) return;
    this.lastBurstAt = tick.time;

    const first = opened[0]!;
    this.journal.write(
      'trade',
      account.id,
      `${side.toUpperCase()} ${opened.length} × ${sizing.volume.toFixed(2)} ${this.config.symbol} @ ${first.openPrice.toFixed(2)} — ${signal.reason} (${(signal.strength * 100).toFixed(0)}%), ${this.botPositions(account).length}/${this.config.maxConcurrentPositions} open`,
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

    const results = await Promise.all(
      Array.from({ length: legs }, (_, i) =>
        this.submit(account, {
          symbol: params.symbol,
          side: params.side,
          volume: params.volume,
          stopLossUsd: params.stopLossUsd,
          takeProfitUsd: params.takeProfitUsd,
          origin: 'manual',
          comment: params.comment ?? 'manual',
          basketIndex: i,
        }),
      ),
    );
    for (const result of results) {
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
