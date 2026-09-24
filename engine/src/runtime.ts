import {
  XAUUSD,
  type Candle,
  type EquityPoint,
  type Position,
  type StateSnapshot,
  type StrategyInfo,
  type Tick,
} from '@sentinal/shared';
import type { KeyValueStore } from '@sentinal/mql5';
import type { TradingAccount } from './broker/account.js';
import { AccountManager } from './broker/manager.js';
import { BotEngine } from './engine/bot.js';
import { CopyTradeEngine } from './engine/copier.js';
import { ExpertBank, type ExpertLibraryStore } from './engine/bank.js';
import type { HistoryProvider } from './engine/expert.js';
import { AiSupervisor, type AiStore } from './engine/ai/supervisor.js';
import type { AiReviewClient } from './engine/ai/review.js';
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
  /** Where the AI's model is saved between sessions. */
  aiStore?: AiStore;
  /** Claude, when an API key is available. */
  aiReviewer?: () => AiReviewClient | null;
  /** Where the EA library is kept between sessions. */
  library?: ExpertLibraryStore;
}

export interface Runtime {
  feed: MarketFeed;
  accounts: AccountManager;
  bot: BotEngine;
  journal: Journal;
  copier: CopyTradeEngine;
  /** The EA library: every EA switched on runs beside the built-in model. */
  experts: ExpertBank;
  /** The AI's supervisor: its status, its saved model, Claude's reviews. */
  ai: AiSupervisor;
  equityCurve: EquityPoint[];
  /** The built-in model, as the terminal shows it. */
  strategyInfo(): StrategyInfo;
  snapshot(): StateSnapshot;
  start(): void;
  stop(): void;
}

const MODEL_NAMES: Record<string, string> = {
  burst: 'Burst',
  ai: 'AI',
  none: 'Off',
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
  const experts = new ExpertBank(journal, () => copier, options.history ?? new FeedHistoryProvider(feed), options.storage);
  experts.setStore(options.library ?? null);
  bot.setExpertBank(experts);
  // The saved model is restored before history is replayed, so bars it has
  // already learned from are not learned twice.
  const ai = new AiSupervisor(bot, accounts, journal, { store: options.aiStore, reviewer: options.aiReviewer });

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
    ai.onTick();

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

  // Fills, stops and manual trades on the master reach every EA as OnTrade;
  // a fill of an EA's own pending order is booked as that EA's trade.
  accounts.on('opened', (position: Position, account: TradingAccount) => {
    if (account === accounts.primary()) experts.onOpened(position);
    experts.notifyTrade();
  });
  accounts.on('closed', () => experts.notifyTrade());

  const strategyInfo = (): StrategyInfo => {
    const running = bot.stats().running && bot.config.strategy !== 'none';
    return {
      source: 'builtin',
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
    ai: ai.status(),
    experts: experts.list(bot.stats().running),
  });

  if (options.banner) journal.write('info', null, options.banner);

  const runtime: Runtime = {
    feed,
    accounts,
    bot,
    journal,
    copier,
    experts,
    ai,
    equityCurve,
    strategyInfo,
    snapshot,
    start: () => feed.start(),
    stop: () => {
      feed.stop();
      void experts.stopAll();
      ai.save();
    },
  };

  // Strategy changes, from any side, go out as one message; the library's
  // state goes out whenever an EA or the bot's running state changes.
  const publishExperts = () => bot.emit('experts', experts.list(bot.stats().running));
  experts.on('experts', publishExperts);
  bot.on('bot', () => {
    bot.emit('strategy', strategyInfo());
    publishExperts();
  });
  ai.on('ai', (status: unknown) => bot.emit('ai', status));

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
