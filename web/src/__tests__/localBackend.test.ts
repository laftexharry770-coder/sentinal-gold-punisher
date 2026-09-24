import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerMessage } from '@sentinal/shared';
import type { MetaApiClient } from '@sentinal/engine';
import { FakeAccount, FakeConnection, makeClient, settle } from '../../../engine/src/__tests__/fakeMetaApi';

/* The browser keeps settings in localStorage; Node has none, so give it one. */
const store = new Map<string, string>();
globalThis.localStorage = {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => void store.set(key, String(value)),
  removeItem: (key: string) => void store.delete(key),
  clear: () => store.clear(),
  key: (i: number) => [...store.keys()][i] ?? null,
  get length() {
    return store.size;
  },
} as Storage;

const sdk = vi.hoisted(() => ({ client: null as MetaApiClient | null }));
vi.mock('../backend/metaapiSdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../backend/metaapiSdk')>()),
  createMetaApiClient: async () => sdk.client!,
}));

const { createLocalBackend } = await import('../backend/local');
const { loadClaudeKey } = await import('../backend/persist');
const { ANGEL_BOT } = await import('../bundledStrategies');

const sample = readFileSync(fileURLToPath(new URL('../../../mql5/samples/Sentinal.mq5', import.meta.url)), 'utf8');

function broker() {
  const masterConn = new FakeConnection({ symbol: 'XAUUSDm', balance: 1000, firstTicket: 7_000_000 });
  const followerConn = new FakeConnection({ symbol: 'XAUUSD', balance: 400, firstTicket: 8_000_000 });
  void masterConn.quote('XAUUSDm', 3300, 3300.2);
  void followerConn.quote('XAUUSD', 3300.1, 3300.3);
  sdk.client = makeClient([
    new FakeAccount('ma-master', 'Exness main', '411285151', 'Exness-MT5Real9', masterConn),
    new FakeAccount('ma-follow', 'Copy account', '5021993', 'ICMarketsSC-MT5-2', followerConn),
  ]);
  return { masterConn, followerConn };
}

describe('the in-browser backend over MetaApi', () => {
  beforeEach(() => store.clear());

  it('lists the token\'s accounts, connects a master and follower, and moves an earlier version\'s saved EA into the library', async () => {
    const { masterConn, followerConn } = broker();
    // What an earlier version kept: one EA in use, its inputs with the settings.
    store.set('sentinal.strategy.v1', JSON.stringify({ files: [{ name: 'Sentinal.mq5', content: sample, encoding: 'text' }], savedAt: 1, active: true }));
    store.set('sentinal.bot.v1', JSON.stringify({ source: 'mql5', expertInputs: { InpAutoTrade: true }, expertTimeframe: 5 }));
    const backend = createLocalBackend();
    const messages: ServerMessage[] = [];
    backend.subscribe({ onMessage: (m) => messages.push(m), onStatus: () => undefined });
    const sessions: string[] = [];
    backend.onSession((s) => sessions.push(s.status));

    const accounts = await backend.listMetaApiAccounts('token');
    expect(accounts.map((a) => [a.name, a.login, a.platform])).toEqual([
      ['Exness main', '411285151', 'mt5'],
      ['Copy account', '5021993', 'mt5'],
    ]);

    await backend.connectBroker({
      token: 'token',
      masterId: 'ma-master',
      followerIds: ['ma-follow'],
      symbol: '',
      remember: true,
      liveExecution: true,
      followerMultiplier: 2,
    });
    const session = backend.sessionState();
    expect(sessions).toEqual(['locked', 'connecting', 'connecting', 'live']);
    expect(session).toMatchObject({
      status: 'live',
      execution: 'broker',
      broker: { login: '12345', broker: 'Exness Technologies Ltd', accountType: 'demo', platform: 'mt5', metaApiId: 'ma-master' },
    });
    expect(backend.savedCredentials()).toEqual({ token: 'token', masterId: 'ma-master', followerIds: ['ma-follow'], symbol: '' });

    const snapshot = messages.find((m) => m.type === 'snapshot');
    if (snapshot?.type !== 'snapshot') throw new Error('no snapshot');
    // It is in the library, switched on with its inputs, and trades alone as it did; Angel Bot sits beside it, off.
    expect(snapshot.payload.experts.map((e) => [e.fileName, e.enabled, e.bundled])).toEqual([
      ['Sentinal.mq5', true, false],
      ['Angel_Bot.mq5', false, true],
    ]);
    expect(snapshot.payload.experts[0]).toMatchObject({ timeframe: 5, inputs: { InpAutoTrade: true } });
    expect(snapshot.payload.bot.strategy).toBe('none');
    expect(store.has('sentinal.strategy.v1')).toBe(false);
    expect(snapshot.payload.bot.symbol).toBe('XAUUSDm');
    expect(snapshot.payload.accounts.map((a) => [a.role, a.symbol, a.provider])).toEqual([
      ['master', 'XAUUSDm', 'metaapi'],
      ['slave', expect.any(String), 'metaapi'],
    ]);

    // A manual order reaches both brokers together, in each one's own symbol and size.
    await backend.saveBotConfig({ stopLossUsd: 0, takeProfitUsd: 0 });
    await settle(50);
    const result = await backend.order({ side: 'buy', volume: 0.01, legs: 1, stopLossUsd: null, takeProfitUsd: null });
    await settle(50);
    expect(result.opened).toHaveLength(1);
    expect(masterConn.sent[0]).toMatchObject({ symbol: 'XAUUSDm', volume: 0.01 });
    expect(followerConn.sent[0]).toMatchObject({ symbol: 'XAUUSD', volume: 0.02 });
    expect(Math.abs(followerConn.sent[0]!.at - masterConn.sent[0]!.at)).toBeLessThan(5);
    expect(messages.some((m) => m.type === 'dispatch')).toBe(true);

    // The master is the session: it cannot be unlinked, only signed out of.
    const masterId = snapshot.payload.accounts[0]!.id;
    await expect(backend.removeAccount(masterId)).rejects.toThrow(/sign out/);

    await backend.signOut();
    expect(backend.sessionState()).toEqual({ status: 'locked', error: null });
    expect(backend.savedCredentials()).toBeNull();
    // Signing out never touches the broker's positions.
    expect(masterConn.state.positions).toHaveLength(1);
  });

  it('stays locked, with the reason, when the master cannot be used', async () => {
    broker();
    const backend = createLocalBackend();
    await expect(
      backend.connectBroker({ token: 't', masterId: 'nope', followerIds: [], symbol: '', remember: false, liveExecution: false, followerMultiplier: 1 }),
    ).rejects.toThrow(/no longer on this MetaApi token/);
    expect(backend.sessionState()).toMatchObject({ status: 'locked', error: expect.stringMatching(/no longer on this MetaApi token/) });
  });

  it('keeps the whole EA library, and the AI, for the next visit', async () => {
    const backend = createLocalBackend();
    await backend.startDemo();
    const added = await backend.addExperts(
      [
        { name: 'Sentinal.mq5', content: sample, encoding: 'text' },
        { name: 'Broken.mq5', content: 'void OnTick() { Nope(); }', encoding: 'text' },
      ],
      { enabled: false },
    );
    expect(added.map((a) => [a.fileName, a.id !== null])).toEqual([
      ['Sentinal.mq5', true],
      ['Broken.mq5', false],
    ]);
    const id = added[0]!.id!;
    await backend.configureExpert(id, { inputs: { InpAutoTrade: true }, timeframe: 5 });
    await backend.setExpertEnabled(id, true);
    await backend.useBuiltinStrategy('ai');
    await backend.setClaudeKey('sk-ant-test-key');
    expect(backend.claudeKey()).toEqual({ where: 'browser', configured: true });
    await backend.signOut();

    const again = createLocalBackend();
    const messages: ServerMessage[] = [];
    again.subscribe({ onMessage: (m) => messages.push(m), onStatus: () => undefined });
    await again.startDemo();
    const snapshot = [...messages].reverse().find((m) => m.type === 'snapshot');
    if (snapshot?.type !== 'snapshot') throw new Error('no snapshot');
    expect(snapshot.payload.experts.map((e) => [e.fileName, e.enabled])).toEqual([
      ['Angel_Bot.mq5', false],
      ['Sentinal.mq5', true],
    ]);
    expect(snapshot.payload.experts.find((e) => e.fileName === 'Sentinal.mq5')).toMatchObject({ timeframe: 5, inputs: { InpAutoTrade: true } });
    expect(snapshot.payload.bot.strategy).toBe('ai');
    expect(snapshot.payload.ai.claude.configured).toBe(true);
    expect(snapshot.payload.ai.reading?.learning.samples).toBeGreaterThan(0);

    // Angel Bot is put in the library once; removed, it stays removed.
    const angel = snapshot.payload.experts.find((e) => e.fileName === 'Angel_Bot.mq5')!;
    await again.removeExpert(angel.id);
    await again.setClaudeKey(null);
    expect(loadClaudeKey()).toBeNull();
    await again.signOut();
    const third = createLocalBackend();
    const later: ServerMessage[] = [];
    third.subscribe({ onMessage: (m) => later.push(m), onStatus: () => undefined });
    await third.startDemo();
    const last = [...later].reverse().find((m) => m.type === 'snapshot');
    if (last?.type !== 'snapshot') throw new Error('no snapshot');
    expect(last.payload.experts.map((e) => e.fileName)).toEqual(['Sentinal.mq5']);
    await third.useBuiltinStrategy('none');
    await third.startBot();
    await settle(50);
    expect(third.sessionState().status).toBe('demo');
    await third.signOut();
  });

  it('runs the bundled Angel Bot on the master and holds the same stop orders on the follower', async () => {
    const { masterConn, followerConn } = broker();
    const backend = createLocalBackend();
    await backend.connectBroker({
      token: 'token',
      masterId: 'ma-master',
      followerIds: ['ma-follow'],
      symbol: '',
      remember: false,
      liveExecution: true,
      followerMultiplier: 1,
    });
    await backend.useBuiltinStrategy('none');
    const [added] = await backend.addExperts([ANGEL_BOT], { enabled: false });
    const angelId = added!.id ?? (await (async () => {
      throw new Error('Angel Bot did not compile');
    })());
    await backend.configureExpert(angelId, { inputs: { InpLots: 0.01 } });
    await backend.setExpertEnabled(angelId, true);
    await backend.startBot();

    const stops = (conn: typeof masterConn) =>
      conn.state.orders
        .filter((o) => o.type === 'ORDER_TYPE_BUY_STOP' || o.type === 'ORDER_TYPE_SELL_STOP')
        .map((o) => `${o.type} ${o.openPrice}`)
        .sort();
    let time = Date.now();
    let bid = 3300;
    for (let i = 0; i < 400 && stops(masterConn).length < 2; i += 1) {
      time += 700;
      bid = +(bid + (i % 2 ? 0.03 : -0.02)).toFixed(2);
      await followerConn.quote('XAUUSD', bid, +(bid + 0.2).toFixed(2), time);
      await masterConn.quote('XAUUSDm', bid, +(bid + 0.2).toFixed(2), time);
      await settle(0);
    }
    await settle(30);
    // A buy stop above and a sell stop below, on both brokers, at the same prices.
    expect(stops(masterConn)).toHaveLength(2);
    expect(stops(followerConn)).toEqual(stops(masterConn));
    const sentStops = followerConn.sent.filter((s) => s.kind === 'createStopBuyOrder' || s.kind === 'createStopSellOrder');
    expect(sentStops.every((s) => s.symbol === 'XAUUSD' && s.volume === 0.01)).toBe(true);
    const clientIds = (conn: typeof masterConn) => conn.state.orders.map((o) => o.clientId).sort();
    expect(clientIds(followerConn)).toEqual(clientIds(masterConn));

    await backend.stopBot();
    await backend.signOut();
  });
});
