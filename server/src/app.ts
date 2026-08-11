import {
  XAUUSD,
  type Candle,
  type EquityPoint,
  type StateSnapshot,
  type Tick,
} from '@sentinal/shared';
import { AccountManager } from './broker/manager.js';
import { config } from './config.js';
import { BotEngine } from './engine/bot.js';
import { CopyTradeEngine } from './engine/copier.js';
import { Journal } from './journal.js';
import { MarketFeed } from './market/feed.js';
import { round } from './util.js';

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

export function createRuntime(): Runtime {
  const journal = new Journal();
  const accounts = new AccountManager();
  const feed = new MarketFeed({
    spec: XAUUSD,
    seedPrice: config.seedPrice,
    intervalMs: config.tickIntervalMs,
    seed: config.randomSeed,
    historyBars: config.historyBars,
  });
  const bot = new BotEngine(accounts, journal);
  const copier = new CopyTradeEngine(accounts, journal);

  const equityCurve: EquityPoint[] = [];
  let barJustClosed = false;
  let lastEquitySample = 0;

  feed.on('candle', ({ closed }: { candle: Candle; closed: boolean }) => {
    if (closed) barJustClosed = true;
  });

  feed.on('tick', (tick: Tick) => {
    // Revalue books first so stop/target hits are booked before new decisions.
    accounts.onTick(tick);

    const closedFlag = barJustClosed;
    barJustClosed = false;
    void bot.onTick(tick, closedFlag);

    if (tick.time - lastEquitySample >= 5000) {
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
    candles: feed.candles.slice(-config.historyBars),
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

  runtime.journal.write('info', null, 'Sentinal MT5 execution server online — XAUUSD feed live');
}
