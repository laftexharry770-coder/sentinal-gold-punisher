import { describe, expect, it } from 'vitest';
import type { ClosedTrade, Position } from '@sentinal/shared';
import { AccountManager } from '../broker/manager.js';
import {
  MetaApiAccount,
  MetaApiGateway,
  attachMetaApi,
  brokerSeconds,
  findGoldSymbol,
  serverOffsetOf,
  type MtPosition,
  type MtSpecification,
} from '../broker/metaapi.js';
import { FakeAccount, FakeConnection, brokerTime, makeClient, settle } from './fakeMetaApi.js';
import { CopyTradeEngine } from '../engine/copier.js';
import { retcodeFor } from '../engine/expert.js';
import { Journal } from '../journal.js';
import { createRuntime } from '../runtime.js';

function metaApiAccount(manager: AccountManager, fake: FakeAccount, role: 'master' | 'slave', extra: { paper?: boolean; masterId?: string } = {}): MetaApiAccount {
  const gateway = new MetaApiGateway(makeClient([fake]));
  manager.registerProvider('metaapi', gateway.factory({ paper: extra.paper, fillWaitMs: 200 }));
  return manager.add({
    name: fake.name,
    provider: 'metaapi',
    metaApiId: fake.id,
    login: fake.login,
    server: fake.server,
    role,
    copy: role === 'slave' ? { enabled: true, masterId: extra.masterId ?? null, sizing: 'multiplier', multiplier: 1 } : undefined,
  }) as MetaApiAccount;
}

describe('MetaApi conversions', () => {
  it('reads broker time and the server offset MQL5 needs', () => {
    expect(brokerSeconds('2026-09-24 14:00:00.000')).toBe(Date.UTC(2026, 8, 24, 14) / 1000);
    const utc = Date.UTC(2026, 8, 24, 11, 0, 7, 450);
    expect(serverOffsetOf(new Date(utc), brokerTime(utc))).toBe(10_800);
  });

  it('finds each broker\'s gold symbol', () => {
    const spec = (symbol: string, tradeMode = 'SYMBOL_TRADE_MODE_FULL'): MtSpecification => ({
      symbol, tickSize: 0.01, minVolume: 0.01, maxVolume: 100, volumeStep: 0.01, contractSize: 100, digits: 2, point: 0.01, tradeMode,
    });
    expect(findGoldSymbol([spec('EURUSD'), spec('XAUUSDm'), spec('XAUEURm')])?.symbol).toBe('XAUUSDm');
    expect(findGoldSymbol([spec('XAUUSD.raw'), spec('XAUUSD')])?.symbol).toBe('XAUUSD');
    expect(findGoldSymbol([spec('GOLD#'), spec('XAUUSD', 'SYMBOL_TRADE_MODE_DISABLED')])?.symbol).toBe('GOLD#');
    expect(findGoldSymbol([spec('XAUUSDm'), spec('XAUUSD.x')], 'xauusd.x')?.symbol).toBe('XAUUSD.x');
    expect(findGoldSymbol([spec('EURUSD')])).toBeUndefined();
  });
});

describe('a MetaApi account', () => {
  it('synchronises with the broker and adopts what it already holds without copying it', async () => {
    const manager = new AccountManager();
    const old: MtPosition = {
      id: 777, type: 'POSITION_TYPE_SELL', symbol: 'XAUUSDm', magic: 0, time: new Date(Date.now() - 3600_000), brokerTime: brokerTime(Date.now() - 3600_000),
      openPrice: 3320, currentPrice: 3310, volume: 0.05, swap: -0.4, profit: 50, commission: -0.35, comment: 'manual',
    };
    const conn = new FakeConnection({ symbol: 'XAUUSDm', balance: 1000, firstTicket: 1_000_000, positions: [old] });
    const fake = new FakeAccount('ma-1', 'Exness demo', '12345', 'Exness-MT5Trial9', conn);
    const opened: Position[] = [];
    manager.on('opened', (p: Position) => opened.push(p));
    const account = metaApiAccount(manager, fake, 'master');
    await account.ready();

    expect(account.connected).toBe(true);
    expect(account.symbol).toBe('XAUUSDm');
    expect(conn.subscribed).toEqual(['XAUUSDm']);
    expect(account.spec().digits).toBe(3);
    expect(account.spec().contractSize).toBe(100);
    expect(account.balance).toBe(1000);
    const state = account.state();
    expect(state).toMatchObject({ broker: 'Exness Technologies Ltd', accountType: 'demo', platform: 'mt5', currency: 'USD', leverage: 2000, login: '12345', quoteIntervalSec: 2.5 });
    expect(account.listPositions()).toHaveLength(1);
    expect(account.listPositions()[0]).toMatchObject({ ticket: 777, side: 'sell', origin: 'external', commission: 0.35, profit: 49.25 });
    expect(opened).toHaveLength(0);

    await conn.quote('XAUUSDm', 3300.123, 3300.323, Date.UTC(2026, 8, 24, 10));
    expect(account.quote()).toMatchObject({ symbol: 'XAUUSDm', bid: 3300.123, ask: 3300.323 });
    expect(account.serverOffset).toBe(10_800);
    expect(account.listPositions()[0]!.currentPrice).toBe(3300.323);
  });

  it('sends a market order with a client id and books the broker\'s fill once', async () => {
    for (const streamFirst of [true, false]) {
      const manager = new AccountManager();
      const conn = new FakeConnection({ symbol: 'XAUUSDm', balance: 1000, firstTicket: 1_000_000 });
      conn.streamFirst = streamFirst;
      const fake = new FakeAccount('ma-1', 'Exness demo', '12345', 'Exness-MT5Trial9', conn);
      const account = metaApiAccount(manager, fake, 'master');
      await account.ready();
      await conn.quote('XAUUSDm', 3300, 3300.2);
      const opened: Position[] = [];
      manager.on('opened', (p: Position) => opened.push(p));

      const result = await account.submit({ symbol: 'XAUUSDm', side: 'buy', volume: 0.013, stopLossUsd: 2, takeProfitUsd: 4, origin: 'bot', comment: 'Sentinal expert advisor v2', magic: 770001, slippagePoints: 30 });
      await settle(20);
      expect(result.ok).toBe(true);
      expect(opened).toHaveLength(1);
      const sent = conn.sent[0]!;
      expect(sent.volume).toBe(0.01);
      // Money stops are converted by the broker at the fill.
      expect(sent.stopLoss).toEqual({ value: 2, units: 'RELATIVE_CURRENCY' });
      expect(sent.takeProfit).toEqual({ value: 4, units: 'RELATIVE_CURRENCY' });
      expect(sent.options.clientId).toMatch(/^S[0-9a-z]+$/);
      expect((sent.options.clientId!.length + (sent.options.comment ?? '').length)).toBeLessThanOrEqual(26);
      expect(sent.options).toMatchObject({ magic: 770001, slippage: 30 });
      const position = account.listPositions()[0]!;
      expect(position).toMatchObject({ side: 'buy', volume: 0.01, openPrice: 3300.2, origin: 'bot', stopLoss: 3298.2, takeProfit: 3304.2, clientId: sent.options.clientId });
    }
  });

  it('reports a broker rejection with the MetaTrader return code', async () => {
    const manager = new AccountManager();
    const conn = new FakeConnection({ symbol: 'XAUUSD', balance: 10, firstTicket: 1 });
    const account = metaApiAccount(manager, new FakeAccount('ma-1', 'Small', '1', 'Broker-Demo', conn), 'master');
    await account.ready();
    await conn.quote('XAUUSD', 3300, 3300.2);
    conn.rejectWith = { message: 'Not enough money', stringCode: 'TRADE_RETCODE_NO_MONEY' };
    const result = await account.submit({ symbol: 'XAUUSD', side: 'sell', volume: 1, origin: 'bot' });
    expect(result).toMatchObject({ ok: false, error: 'Not enough money', code: 'TRADE_RETCODE_NO_MONEY' });
    expect(retcodeFor(result.ok ? '' : result.error, result.ok ? undefined : result.code)).toBe(10019);
    expect(account.listPositions()).toHaveLength(0);
  });

  it('books closes from the broker\'s deals — requested, stopped out and partial', async () => {
    const manager = new AccountManager();
    const conn = new FakeConnection({ symbol: 'XAUUSDm', balance: 1000, firstTicket: 5_000 });
    const account = metaApiAccount(manager, new FakeAccount('ma-1', 'Exness', '1', 'Exness-MT5Trial9', conn), 'master');
    await account.ready();
    await conn.quote('XAUUSDm', 3300, 3300.2);
    const closed: ClosedTrade[] = [];
    const partials: ClosedTrade[] = [];
    manager.on('closed', (t: ClosedTrade) => closed.push(t));
    manager.on('partial', (t: ClosedTrade) => partials.push(t));

    const a = await account.submit({ symbol: 'XAUUSDm', side: 'buy', volume: 0.1, origin: 'bot' });
    if (!a.ok) throw new Error(a.error);
    await conn.quote('XAUUSDm', 3302, 3302.2);
    const trade = await account.submitClose(a.position.id, 'basket-tp');
    expect(trade).toMatchObject({ reason: 'basket-tp', closePrice: 3302, profit: 18, volume: 0.1 });
    expect(trade!.commission).toBeCloseTo(0.7, 6);
    expect(trade!.netProfit).toBeCloseTo(17.3, 6);
    expect(closed).toHaveLength(1);
    expect(account.balance).toBe(1018);

    // The broker's stop loss fires on its own.
    const b = await account.submit({ symbol: 'XAUUSDm', side: 'sell', volume: 0.02, origin: 'bot' });
    if (!b.ok) throw new Error(b.error);
    await conn.quote('XAUUSDm', 3310, 3310.2);
    await conn.closeAtBroker(String(b.position.ticket), 'DEAL_REASON_SL');
    expect(closed).toHaveLength(2);
    expect(closed[1]).toMatchObject({ reason: 'sl', closePrice: 3310.2, profit: -16.4 });

    // Part of a position closed in MetaTrader.
    const c = await account.submit({ symbol: 'XAUUSDm', side: 'buy', volume: 0.3, origin: 'bot' });
    if (!c.ok) throw new Error(c.error);
    await conn.closeAtBroker(String(c.position.ticket), 'DEAL_REASON_CLIENT', 0.1);
    expect(partials).toHaveLength(1);
    expect(partials[0]).toMatchObject({ volume: 0.1, reason: 'manual' });
    expect(account.getPosition(c.position.id)?.volume).toBe(0.2);
    const rest = await account.submitClose(c.position.id, 'manual', 0.05);
    expect(rest).toMatchObject({ volume: 0.05 });
    expect(account.getPosition(c.position.id)?.volume).toBe(0.15);
    expect(closed).toHaveLength(2);
  });

  it('moves stops at the broker and keeps pending orders in step with it', async () => {
    const manager = new AccountManager();
    const conn = new FakeConnection({ symbol: 'XAUUSD', balance: 1000, firstTicket: 10 });
    const account = metaApiAccount(manager, new FakeAccount('ma-1', 'A', '1', 'S', conn), 'master');
    await account.ready();
    await conn.quote('XAUUSD', 3300, 3300.2);
    const modified: Position[] = [];
    manager.on('modified', (p: Position) => modified.push(p));
    const a = await account.submit({ symbol: 'XAUUSD', side: 'buy', volume: 0.01, origin: 'bot' });
    if (!a.ok) throw new Error(a.error);
    const result = await account.submitModify(a.position.id, 3295, 3310);
    expect(result.ok).toBe(true);
    expect(conn.modifies[0]).toEqual({ positionId: String(a.position.ticket), stopLoss: 3295, takeProfit: 3310 });
    expect(account.getPosition(a.position.id)).toMatchObject({ stopLoss: 3295, takeProfit: 3310 });
    expect(modified).toHaveLength(1);

    const pending = await account.submitPending({ symbol: 'XAUUSD', type: 'buy-limit', volume: 0.02, openPrice: 3290, stopLoss: 3285, takeProfit: 3300 });
    if (!pending.ok) throw new Error(pending.error);
    expect(conn.sent.at(-1)?.kind).toBe('createLimitBuyOrder');
    expect(account.listOrders()).toHaveLength(1);
    expect(account.listOrders()[0]).toMatchObject({ type: 'buy-limit', openPrice: 3290, volume: 0.02 });
    const cancelled = await account.cancelPending(pending.order.id);
    expect(cancelled.ok).toBe(true);
    expect(account.listOrders()).toHaveLength(0);
  });

  it('paper-trades against the broker\'s quotes without sending an order', async () => {
    const manager = new AccountManager();
    const conn = new FakeConnection({ symbol: 'XAUUSDm', balance: 750, firstTicket: 10 });
    const account = metaApiAccount(manager, new FakeAccount('ma-1', 'A', '1', 'S', conn), 'master', { paper: true });
    await account.ready();
    await conn.quote('XAUUSDm', 3300, 3300.2);
    const result = await account.submit({ symbol: 'XAUUSDm', side: 'buy', volume: 0.01, stopLossUsd: 1, origin: 'bot' });
    expect(result.ok).toBe(true);
    expect(conn.sent).toHaveLength(0);
    expect(account.balance).toBe(750);
    // The simulated stop is held against the real quotes.
    await conn.quote('XAUUSDm', 3299, 3299.2);
    expect(account.listPositions()).toHaveLength(0);
    expect(account.history[0]).toMatchObject({ reason: 'sl' });
  });

  it('never closes broker positions when the account is removed from the terminal', async () => {
    const manager = new AccountManager();
    const conn = new FakeConnection({ symbol: 'XAUUSD', balance: 1000, firstTicket: 10 });
    const account = metaApiAccount(manager, new FakeAccount('ma-1', 'A', '1', 'S', conn), 'master');
    await account.ready();
    await conn.quote('XAUUSD', 3300, 3300.2);
    await account.submit({ symbol: 'XAUUSD', side: 'buy', volume: 0.01, origin: 'bot' });
    manager.remove(account.id);
    expect(conn.closes).toHaveLength(0);
    expect(conn.state.positions).toHaveLength(1);
    expect(conn.listeners).toHaveLength(0);
  });
});

describe('copying between MetaApi accounts', () => {
  async function pair(opts: { masterLatency: number; followerLatency: number }) {
    const journal = new Journal();
    const manager = new AccountManager();
    const masterConn = new FakeConnection({ symbol: 'XAUUSD', balance: 5000, firstTicket: 100_000 });
    const followerConn = new FakeConnection({ symbol: 'XAUUSDm', balance: 500, firstTicket: 200_000 });
    masterConn.latencyMs = opts.masterLatency;
    followerConn.latencyMs = opts.followerLatency;
    const fakes = [
      new FakeAccount('ma-master', 'IC Markets', '1', 'ICMarketsSC-MT5', masterConn),
      new FakeAccount('ma-follower', 'Exness', '2', 'Exness-MT5Trial9', followerConn),
    ];
    const gateway = new MetaApiGateway(makeClient(fakes));
    manager.registerProvider('metaapi', gateway.factory({ fillWaitMs: 200 }));
    const copier = new CopyTradeEngine(manager, journal);
    const master = manager.add({ name: 'Master', provider: 'metaapi', metaApiId: 'ma-master', login: '1', server: 'x', role: 'master' }) as MetaApiAccount;
    const follower = manager.add({
      name: 'Follower', provider: 'metaapi', metaApiId: 'ma-follower', login: '2', server: 'y', role: 'slave',
      copy: { enabled: true, masterId: master.id, sizing: 'multiplier', multiplier: 2 },
    }) as MetaApiAccount;
    await Promise.all([master.ready(), follower.ready()]);
    await masterConn.quote('XAUUSD', 3300, 3300.2);
    await followerConn.quote('XAUUSDm', 3300.05, 3300.25);
    return { manager, copier, master, follower, masterConn, followerConn, journal, gateway };
  }

  it('sends to the master and the follower in the same instant, in each broker\'s symbol', async () => {
    const { copier, master, follower, masterConn, followerConn } = await pair({ masterLatency: 80, followerLatency: 30 });
    const result = await copier.open(master, { symbol: 'XAUUSD', side: 'buy', volume: 0.05, stopLossUsd: 5, origin: 'bot', comment: 'Sentinal' });
    await settle(250);
    expect(result.ok).toBe(true);
    const m = masterConn.sent[0]!;
    const f = followerConn.sent[0]!;
    // The follower did not wait for the master's 80 ms answer.
    expect(Math.abs(f.at - m.at)).toBeLessThan(5);
    expect(f.symbol).toBe('XAUUSDm');
    expect(f.volume).toBe(0.1);
    // Same stop price on both accounts: the master's dollars, converted once.
    expect(m.stopLoss).toEqual({ value: 5, units: 'RELATIVE_CURRENCY' });
    expect(f.stopLoss).toBe(3299.2);
    expect(f.options.clientId).toBe(m.options.clientId);
    expect(follower.listPositions()[0]).toMatchObject({ origin: 'copy', volume: 0.1, sourceId: master.listPositions()[0]!.id });
    const report = copier.recent()[0]!;
    expect(report.sendSpreadMs).toBeLessThan(5);
    expect(report.legs.map((l) => l.ok)).toEqual([true, true]);

    // A close reaches both brokers together.
    await copier.close(master, master.listPositions()[0]!.id, 'manual');
    await settle(100);
    expect(Math.abs(followerConn.closes[0]!.at - masterConn.closes[0]!.at)).toBeLessThan(5);
    expect(master.listPositions()).toHaveLength(0);
    expect(follower.listPositions()).toHaveLength(0);
  });

  it('mirrors a trade placed in MetaTrader itself, and follows its stop changes and close', async () => {
    const { copier, master, follower, masterConn, followerConn } = await pair({ masterLatency: 0, followerLatency: 0 });
    copier.mirrorExternal = true;
    // An EA running in the user's MT5 opens a position on the master.
    const p = await masterConn.openAtBroker({ side: 'sell', volume: 0.04, symbol: 'XAUUSD', sl: 3310, tp: 3290, magic: 5150, comment: 'Angel' });
    await settle(30);
    expect(master.listPositions()[0]).toMatchObject({ origin: 'external', ticket: p.id });
    expect(followerConn.sent).toHaveLength(1);
    expect(followerConn.sent[0]).toMatchObject({ kind: 'createMarketSellOrder', symbol: 'XAUUSDm', volume: 0.08, stopLoss: 3310, takeProfit: 3290 });
    expect(followerConn.sent[0]!.options.clientId).toBe(CopyTradeEngine.copyClientId(Number(p.id)));

    // The EA trails its stop in MT5: the copy follows.
    p.stopLoss = 3305;
    await masterConn.quote('XAUUSD', 3299, 3299.2);
    for (const listener of masterConn.listeners) await listener.onPositionUpdated!('x', p);
    await settle(20);
    expect(followerConn.modifies[0]).toMatchObject({ stopLoss: 3305, takeProfit: 3290 });

    // And the EA closes it: the copy closes too.
    await masterConn.closeAtBroker(String(p.id), 'DEAL_REASON_EXPERT');
    await settle(30);
    expect(follower.listPositions()).toHaveLength(0);
  });

  it('matches copies to their master again after the terminal restarts', async () => {
    const { copier, master, follower, masterConn, followerConn, journal, manager } = await pair({ masterLatency: 0, followerLatency: 0 });
    const result = await copier.open(master, { symbol: 'XAUUSD', side: 'buy', volume: 0.02, origin: 'bot' });
    if (!result.ok) throw new Error(result.error);
    await settle(20);
    expect(copier.linksOf(result.position.id)).toHaveLength(1);

    // A fresh terminal: new copier, new accounts over the same broker books.
    const manager2 = new AccountManager();
    const gateway2 = new MetaApiGateway(makeClient([
      new FakeAccount('ma-master', 'IC Markets', '1', 'x', masterConn),
      new FakeAccount('ma-follower', 'Exness', '2', 'y', followerConn),
    ]));
    manager2.registerProvider('metaapi', gateway2.factory({ fillWaitMs: 200 }));
    const copier2 = new CopyTradeEngine(manager2, journal);
    masterConn.listeners = [];
    followerConn.listeners = [];
    const master2 = manager2.add({ name: 'Master', provider: 'metaapi', metaApiId: 'ma-master', login: '1', server: 'x', role: 'master' }) as MetaApiAccount;
    const follower2 = manager2.add({
      name: 'Follower', provider: 'metaapi', metaApiId: 'ma-follower', login: '2', server: 'y', role: 'slave',
      copy: { enabled: true, masterId: master2.id, sizing: 'multiplier', multiplier: 2 },
    }) as MetaApiAccount;
    await Promise.all([master2.ready(), follower2.ready()]);
    const masterPosition = master2.listPositions()[0]!;
    expect(masterPosition.origin).toBe('bot');
    expect(follower2.listPositions()[0]!.origin).toBe('copy');
    expect(copier2.linksOf(masterPosition.id)).toEqual([{ accountId: follower2.id, positionId: follower2.listPositions()[0]!.id }]);

    // The master closes in MT5 while this terminal watches: the copy follows.
    await masterConn.closeAtBroker(String(masterPosition.ticket));
    await settle(30);
    expect(follower2.listPositions()).toHaveLength(0);
    void manager;
    void follower;
  });

  it('attaches a MetaApi master and follower to a runtime', async () => {
    const masterConn = new FakeConnection({ symbol: 'XAUUSDm', balance: 2500, firstTicket: 1 });
    const followerConn = new FakeConnection({ symbol: 'GOLD', balance: 800, firstTicket: 50_000 });
    const client = makeClient([
      new FakeAccount('ma-1', 'Main', '11', 'Exness-MT5Real9', masterConn),
      new FakeAccount('ma-2', 'Second', '22', 'Other-Live', followerConn),
    ]);
    const gateway = new MetaApiGateway(client);
    const runtime = createRuntime({ seedPrice: 0, tickIntervalMs: 1000, seed: null, historyBars: 240, source: 'external' });
    await masterConn.quote('XAUUSDm', 3301.5, 3301.7);
    const link = await attachMetaApi(runtime, gateway, { masterId: 'ma-1', followerIds: ['ma-2'], paper: false, followerCopy: { multiplier: 0.5 } });
    await link.followers[0]!.ready();

    expect(runtime.bot.config.symbol).toBe('XAUUSDm');
    expect(runtime.feed.spec.digits).toBe(3);
    expect(runtime.feed.candles.length).toBeGreaterThanOrEqual(50);
    expect(runtime.feed.candles[0]!.time).toBeLessThan(runtime.feed.candles.at(-1)!.time);
    expect(runtime.feed.quote).toMatchObject({ symbol: 'XAUUSDm', bid: 3301.5 });
    const states = runtime.accounts.states();
    expect(states.map((s) => [s.role, s.symbol, s.balance])).toEqual([
      ['master', 'XAUUSDm', 2500],
      ['slave', 'GOLD', 800],
    ]);
    expect(runtime.accounts.list()[1]!.config.copy).toMatchObject({ enabled: true, masterId: link.master.id, multiplier: 0.5 });

    // Quotes from the master's stream drive the feed.
    await masterConn.quote('XAUUSDm', 3302, 3302.2);
    expect(runtime.feed.quote).toMatchObject({ bid: 3302, ask: 3302.2 });

    // An EA's history comes from the broker, in server time, oldest first.
    const bars = await link.master.loadBars('XAUUSDm', 16385, 20);
    expect(bars).toHaveLength(20);
    expect(bars[1]!.time - bars[0]!.time).toBe(3600);
    link.detach();
    expect(masterConn.listeners).toHaveLength(0);
  });

  it('adds a MetaTrader login to MetaApi with tick-by-tick quotes', async () => {
    const client = makeClient([]);
    const gateway = new MetaApiGateway(client);
    const summary = await gateway.provision({ name: 'Exness', login: '5550001', password: 'secret', server: 'Exness-MT5Real9', platform: 'mt5' });
    expect(summary).toMatchObject({ name: 'Exness', login: '5550001', server: 'Exness-MT5Real9', platform: 'mt5' });
    expect(client.created[0]).toMatchObject({ login: '5550001', password: 'secret', server: 'Exness-MT5Real9', platform: 'mt5', quoteStreamingIntervalInSeconds: 0 });
  });
});
