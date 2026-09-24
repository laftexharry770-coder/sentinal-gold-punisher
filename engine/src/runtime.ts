import {
  XAUUSD,
  type Candle,
  type EquityPoint,
  type StateSnapshot,
  type StrategyInfo,
  type Tick,
} from '@sentinal/shared';
import type { Ex5Info, KeyValueStore } from '@sentinal/mql5';
import { AccountManager } from './broker/manager.js';
import { BotEngine } from './engine/bot.js';
import { CopyTradeEngine } from './engine/copier.js';
import { ExpertRunner, type HistoryProvider } from './engine/expert.js';
import { Journal } from './journal.js';
import { MarketFeed } from './market/feed.js';
import { FeedHistoryProvider } from './market/history.js';
import { round } from './util.js';

export interface RuntimeOptions {
  seedPrice: number;
  tickIntervalMs: number;
  /** Fixed seed for a reproducible price series, or null for a fresh one. */
  seed: number | null;
  historyBars: number;
  equitySampleMs?: number;
  /** 'external' waits for a broker to push quotes instead of simulating them. */
  source?: 'simulated' | 'external';
  /** Message written to the journal once the runtime is composed. */
  banner?: string;
  /** Where an uploaded EA's history comes from; defaults to the feed's own bars. */
  history?: HistoryProvider;
  /** Persistence for an EA's global variables and files. */
  storage?: KeyValueStore;
}

/** A compiled .ex5 the operator runs in MetaTrader: the engine only mirrors it. */
export interface MirrorStrategy {
  info: Ex5Info;
  loadedAt: number;
}

export interface Runtime {
  feed: MarketFeed;
  accounts: AccountManager;
  bot: BotEngine;
  journal: Journal;
  copier: CopyTradeEngine;
  expert: ExpertRunner;
  equityCurve: EquityPoint[];
  mirror: MirrorStrategy | null;
  setMirror(mirror: MirrorStrategy | null): void;
  strategyInfo(): StrategyInfo;
  snapshot(): StateSnapshot;
  start(): void;
  stop(): void;
}

const MODEL_NAMES: Record<string, string> = {
  burst: 'Burst',
  'adaptive-scalp': 'Adaptive scalp',
  momentum: 'Momentum breakout',
  'mean-reversion': 'Mean reversion',
};

/**
 * Composes the whole trading stack: feed → accounts → bot → dispatcher, with
 * an MQL5 runner beside the built-in models.
 *
 * Nothing here touches the network or the filesystem, so the same runtime backs
 * the Node execution server and the browser-only build of the terminal.
 */
export function createRuntime(options: RuntimeOptions): Runtime {
  const { historyBars, equitySampleMs = 5000 } = options;

  const journal = new Journal();
  const accounts = new AccountManager();
  const feed = new MarketFeed({
    spec: XAUUSD,
    seedPrice: options.seedPrice,
    intervalMs: options.tickIntervalMs,
    seed: options.seed,
    historyBars,
    source: options.source,
  });
  const bot = new BotEngine(accounts, journal);
  const copier = new CopyTradeEngine(accounts, journal);
  // Every order the bot sends reaches the master and the followers together.
  bot.setDispatcher(copier);
  const expert = new ExpertRunner(journal, () => copier, options.history ?? new FeedHistoryProvider(feed), options.storage);
  bot.setExpertRunner(expert);

  // Load history into the indicators so arming the bot acts on the next tick
  // rather than after a warm-up delay. An external feed has no history yet, so
  // the caller primes it once the broker's bars arrive.
  if (!feed.isExternal) bot.prime(feed.candles);

  const equityCurve: EquityPoint[] = [];
  let barJustClosed = false;
  let lastEquitySample = 0;

  feed.on('candle', (payload: unknown) => {
    if ((payload as { candle: Candle; closed: boolean }).closed) barJustClosed = true;
  });

  feed.on('tick', (payload: unknown) => {
    const tick = payload as Tick;
    // Revalue books first so stop/target hits are booked before new decisions.
    accounts.onTick(tick);

    const closedFlag = barJustClosed;
    barJustClosed = false;
    void bot.onTick(tick, closedFlag);

    if (tick.time - lastEquitySample >= equitySampleMs) {
      lastEquitySample = tick.time;
      const portfolio = accounts.portfolio();
      const point: EquityPoint = {
        time: tick.time,
        equity: round(portfolio.equity),
        balance: round(portfolio.balance),
      };
      equityCurve.push(point);
      if (equityCurve.length > 720) equityCurve.shift();
      feed.emit('equity', point);
    }
  });

  // Fills, stops and manual trades on the master reach the EA as OnTrade.
  accounts.on('opened', () => expert.notifyTrade());
  accounts.on('closed', () => expert.notifyTrade());

  let mirror: MirrorStrategy | null = null;

  const strategyInfo = (): StrategyInfo => {
    const source = bot.config.source;
    if (source === 'mql5') return expert.info();
    const running = bot.stats().running;
    if (source === 'mirror') {
      return {
        source,
        name: mirror ? mirror.info.name.replace(/\.ex5$/i, '') : 'MetaTrader EA',
        fileName: mirror?.info.name ?? null,
        status: running ? 'running' : 'idle',
        detail: running ? 'copying every position the EA opens on the master' : null,
        inputs: [],
        diagnostics: [],
        fingerprint: mirror?.info.sha256 ?? null,
        comment: '',
        panel: [],
        lastTickMs: null,
        ticks: 0,
        loadedAt: mirror?.loadedAt ?? null,
      };
    }
    return {
      source,
      name: MODEL_NAMES[bot.config.strategy] ?? bot.config.strategy,
      fileName: null,
      status: running ? 'running' : 'idle',
      detail: bot.stats().lastSignal?.reason ?? null,
      inputs: [],
      diagnostics: [],
      fingerprint: null,
      comment: '',
      panel: [],
      lastTickMs: null,
      ticks: bot.stats().signalsEvaluated,
      loadedAt: null,
    };
  };

  const snapshot = (): StateSnapshot => ({
    quote: feed.quote,
    candles: feed.candles.slice(-historyBars),
    accounts: accounts.states(),
    positions: accounts.allPositions(),
    history: accounts.allHistory(),
    logs: journal.list(),
    recoveries: bot.listRecoveries(),
    bot: bot.config,
    stats: bot.stats(),
    portfolio: accounts.portfolio(),
    equityCurve,
    strategy: strategyInfo(),
    dispatches: copier.recent(),
    orders: accounts.allOrders(),
  });

  if (options.banner) journal.write('info', null, options.banner);

  const runtime: Runtime = {
    feed,
    accounts,
    bot,
    journal,
    copier,
    expert,
    equityCurve,
    get mirror() {
      return mirror;
    },
    setMirror(next) {
      mirror = next;
      bot.emit('strategy', strategyInfo());
    },
    strategyInfo,
    snapshot,
    start: () => feed.start(),
    stop: () => {
      feed.stop();
      void expert.stop();
    },
  };

  // Strategy changes, from any side, go out as one message.
  expert.on('strategy', () => bot.emit('strategy', strategyInfo()));
  bot.on('bot', () => bot.emit('strategy', strategyInfo()));

  return runtime;
}

/** Seeds a master plus a follower so the terminal is usable on first launch. */
export function seedDemoAccounts(runtime: Runtime): void {
  const master = runtime.accounts.add({
    name: 'Sentinal Master',
    provider: 'sim',
    login: '51204418',
    server: 'SentinalMarkets-Live01',
    broker: 'Sentinal Markets',
    role: 'master',
    initialBalance: 10_000,
    leverage: 500,
  });

  runtime.accounts.add({
    name: 'Follower A',
    provider: 'sim',
    login: '51204419',
    server: 'SentinalMarkets-Live02',
    broker: 'Sentinal Markets',
    role: 'slave',
    initialBalance: 5_000,
    leverage: 500,
    copy: { enabled: true, masterId: master.id, sizing: 'multiplier', multiplier: 1 },
  });
}
