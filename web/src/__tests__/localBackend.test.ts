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
const { saveStrategyFiles } = await import('../backend/persist');

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

  it('lists the token\'s accounts, connects a master and follower, and restores the saved EA', async () => {
    const { masterConn, followerConn } = broker();
    saveStrategyFiles([{ name: 'Sentinal.mq5', content: sample, encoding: 'text' }]);
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
    expect(snapshot.payload.strategy).toMatchObject({ source: 'mql5', name: 'Sentinal', fileName: 'Sentinal.mq5' });
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

  it('keeps an uploaded strategy for the next visit, and switches between it and Burst without a new upload', async () => {
    const backend = createLocalBackend();
    await backend.startDemo();
    const outcome = await backend.loadStrategy([{ name: 'Sentinal.mq5', content: sample, encoding: 'text' }]);
    expect(outcome.kind === 'mql5' && outcome.result.ok).toBe(true);
    await backend.configureExpert({ inputs: { InpAutoTrade: true }, timeframe: 5 });

    const again = createLocalBackend();
    const messages: ServerMessage[] = [];
    again.subscribe({ onMessage: (m) => messages.push(m), onStatus: () => undefined });
    await again.startDemo();
    const snapshot = [...messages].reverse().find((m) => m.type === 'snapshot');
    if (snapshot?.type !== 'snapshot') throw new Error('no snapshot');
    expect(snapshot.payload.strategy.source).toBe('mql5');
    expect(snapshot.payload.bot).toMatchObject({ expertTimeframe: 5, expertInputs: { InpAutoTrade: true } });

    await again.useBuiltinStrategy('burst');
    // Switching to Burst keeps the EA, ready to switch back to without an upload.
    expect(await again.savedStrategy()).toMatchObject({ fileName: 'Sentinal.mq5', kind: 'mql5', active: false });
    const back = await again.useSavedStrategy();
    expect(back.kind === 'mql5' && back.result.ok).toBe(true);
    expect(await again.savedStrategy()).toMatchObject({ active: true });
    await again.useBuiltinStrategy('burst');
    const third = createLocalBackend();
    const later: ServerMessage[] = [];
    third.subscribe({ onMessage: (m) => later.push(m), onStatus: () => undefined });
    await third.startDemo();
    const last = [...later].reverse().find((m) => m.type === 'snapshot');
    if (last?.type !== 'snapshot') throw new Error('no snapshot');
    expect(last.payload.strategy.source).toBe('builtin');
    expect(last.payload.strategy.name).toBe('Burst');
    expect(await third.savedStrategy()).toMatchObject({ fileName: 'Sentinal.mq5', active: false });
    await third.forgetSavedStrategy();
    expect(await third.savedStrategy()).toBeNull();
    await backend.signOut();
    await again.signOut();
    await third.signOut();
  });
});
