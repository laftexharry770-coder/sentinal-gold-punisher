import {
  XAUUSD,
  type Candle,
  type EquityPoint,
  type StateSnapshot,
  type Tick,
} from '@sentinal/shared';
import { AccountManager } from './broker/manager.js';
import { BotEngine } from './engine/bot.js';
import { CopyTradeEngine } from './engine/copier.js';
import { Journal } from './journal.js';
import { MarketFeed } from './market/feed.js';
import { round } from './util.js';

export interface RuntimeOptions {
  seedPrice: number;
  tickIntervalMs: number;
  /** Fixed seed for a reproducible price series, or null for a fresh one. */
  seed: number | null;
  historyBars: number;
  equitySampleMs?: number;
  /** Message written to the journal once the runtime is composed. */
  banner?: string;
}

export interface Runtime {
  feed: MarketFeed;
  accounts: AccountManager;
  bot: BotEngine;
  journal: Journal;
  copier: CopyTradeEngine;
  equityCurve: EquityPoint[];
  snapshot(): StateSnapshot;
  start(): void;
  stop(): void;
}

/**
 * Composes the whole trading stack: feed → accounts → bot → copier.
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
  });
  const bot = new BotEngine(accounts, journal);
  const copier = new CopyTradeEngine(accounts, journal);

  // Load the seeded history into the indicators so arming the bot acts on the
  // next tick rather than after a warm-up delay.
  bot.prime(feed.candles);

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
  });

  if (options.banner) journal.write('info', null, options.banner);

  return {
    feed,
    accounts,
    bot,
    journal,
    copier,
    equityCurve,
    snapshot,
    start: () => feed.start(),
    stop: () => feed.stop(),
  };
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
