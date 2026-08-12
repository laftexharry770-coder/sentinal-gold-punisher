import {
  addAccount,
  closeAll,
  closePosition,
  createRuntime,
  placeOrder,
  removeAccount,
  seedDemoAccounts,
  startBot,
  stopBot,
  updateAccount,
  updateBotConfig,
  type Runtime,
} from '@sentinal/engine';
import type {
  AccountState,
  BotConfig,
  Candle,
  ClosedTrade,
  CopySettings,
  EquityPoint,
  LogEntry,
  Position,
  RecoveryTask,
  ServerMessage,
  Tick,
} from '@sentinal/shared';
import {
  MetaApiClient,
  clearCredentials,
  loadCredentials,
  saveCredentials,
  type BrokerCredentials,
} from '../broker/metaapiClient';
import { LOCKED, type ConnectInput, type SessionState } from './session';
import type {
  BotView,
  NewAccountPayload,
  OrderPayload,
  Subscription,
  TerminalBackend,
} from './types';

/** How often the broker is polled for a fresh XAUUSD quote. */
const QUOTE_POLL_MS = 1000;
/** How often the broker's own balance and equity are refreshed. */
const ACCOUNT_POLL_MS = 15_000;

/**
 * Runs the engine inside the browser tab.
 *
 * Nothing starts until a session exists: no feed, no accounts, no prices. A
 * broker session drives the feed from real MetaApi quotes; demo mode is an
 * explicit choice and is labelled as simulated throughout the UI.
 */
export function createLocalBackend(): TerminalBackend {
  let runtime: Runtime | null = null;
  let session: SessionState = LOCKED;
  let quoteTimer: number | undefined;
  let accountTimer: number | undefined;

  const sessionListeners = new Set<(state: SessionState) => void>();
  const streamListeners = new Set<Subscription>();

  const setSession = (next: SessionState): void => {
    session = next;
    for (const listener of sessionListeners) listener(session);
  };

  const emit = (message: ServerMessage): void => {
    for (const listener of streamListeners) listener.onMessage(message);
  };

  const pushBook = (rt: Runtime): void => {
    emit({ type: 'positions', payload: rt.accounts.allPositions() });
    emit({ type: 'accounts', payload: rt.accounts.states() });
    emit({ type: 'portfolio', payload: rt.accounts.portfolio() });
  };

  /** Wires a fresh runtime's events onto the message stream. */
  const attach = (rt: Runtime): void => {
    let lastBookPush = 0;

    rt.feed.on('tick', (payload: unknown) => {
      const tick = payload as Tick;
      emit({ type: 'tick', payload: tick });
      if (tick.time - lastBookPush >= 500) {
        lastBookPush = tick.time;
        pushBook(rt);
      }
    });
    rt.feed.on('candle', (payload: unknown) =>
      emit({ type: 'candle', payload: payload as { candle: Candle; closed: boolean } }),
    );
    rt.feed.on('equity', (payload: unknown) => emit({ type: 'equity', payload: payload as EquityPoint }));
    rt.journal.on('log', (payload: unknown) => emit({ type: 'log', payload: payload as LogEntry }));
    rt.accounts.on('accounts', (payload: unknown) =>
      emit({ type: 'accounts', payload: payload as AccountState[] }),
    );
    rt.accounts.on('opened', () => {
      emit({ type: 'positions', payload: rt.accounts.allPositions() });
      emit({ type: 'accounts', payload: rt.accounts.states() });
    });
    rt.accounts.on('closed', () => {
      emit({ type: 'positions', payload: rt.accounts.allPositions() });
      emit({ type: 'history', payload: rt.accounts.allHistory() });
      emit({ type: 'accounts', payload: rt.accounts.states() });
      emit({ type: 'portfolio', payload: rt.accounts.portfolio() });
    });
    rt.bot.on('bot', (payload: unknown) => emit({ type: 'bot', payload: payload as BotView }));
    rt.bot.on('recoveries', (payload: unknown) =>
      emit({ type: 'recoveries', payload: payload as RecoveryTask[] }),
    );
  };

  const teardown = (): void => {
    window.clearInterval(quoteTimer);
    window.clearInterval(accountTimer);
    quoteTimer = undefined;
    accountTimer = undefined;
    runtime?.stop();
    runtime = null;
  };

  const requireRuntime = (): Runtime => {
    if (!runtime) throw new Error('Connect a broker before trading.');
    return runtime;
  };

  /* ------------------------------------------------------------------ */
  /* Sessions                                                            */
  /* ------------------------------------------------------------------ */

  const connectBroker = async (input: ConnectInput): Promise<void> => {
    teardown();
    setSession({ status: 'connecting', error: null });

    const credentials: BrokerCredentials = {
      token: input.token.trim(),
      accountId: input.accountId.trim(),
      region: input.region,
      symbol: input.symbol.trim().toUpperCase() || 'XAUUSD',
    };

    try {
      const api = new MetaApiClient(credentials);
      // Validating first means a bad token never leaves a half-built terminal.
      const info = await api.accountInfo();

      const rt = createRuntime({
        seedPrice: 0,
        tickIntervalMs: QUOTE_POLL_MS,
        seed: null,
        historyBars: 240,
        source: 'external',
        banner: `Connected to ${info.broker} · ${info.server} — live ${credentials.symbol} feed`,
      });
      attach(rt);
      runtime = rt;

      rt.bot.updateConfig({ symbol: credentials.symbol });

      // Real bars first, so the chart and the indicators open on broker history.
      const history = await api.history(240).catch(() => [] as Candle[]);
      if (history.length > 0) {
        rt.feed.seedCandles(history);
        rt.bot.prime(history);
      }

      addAccount(rt, {
        name: `${info.broker} ${info.login}`.trim(),
        provider: 'metaapi',
        login: info.login,
        server: info.server,
        broker: info.broker,
        currency: info.currency,
        leverage: info.leverage,
        initialBalance: info.balance,
        role: 'master',
      });

      const tick = await api.currentPrice();
      rt.feed.pushTick(tick);
      emit({ type: 'snapshot', payload: rt.snapshot() });

      quoteTimer = window.setInterval(() => {
        void api
          .currentPrice()
          .then((next) => rt.feed.pushTick(next))
          .catch((err) => {
            rt.journal.write('warn', null, `Quote poll failed: ${err instanceof Error ? err.message : 'error'}`);
          });
      }, QUOTE_POLL_MS);

      accountTimer = window.setInterval(() => {
        void api
          .accountInfo()
          .then((fresh) => {
            rt.journal.write(
              'info',
              null,
              `Broker balance ${fresh.currency} ${fresh.balance.toFixed(2)} · equity ${fresh.equity.toFixed(2)}`,
            );
          })
          .catch(() => {
            /* transient; the quote poll surfaces persistent failures */
          });
      }, ACCOUNT_POLL_MS);

      if (input.remember) saveCredentials(credentials);
      else clearCredentials();

      setSession({
        status: 'live',
        broker: { login: info.login, server: info.server, broker: info.broker, currency: info.currency },
        // Order routing is not implemented in the browser build; fills are
        // simulated against the broker's real prices.
        execution: 'local',
      });
    } catch (err) {
      teardown();
      setSession({ status: 'locked', error: err instanceof Error ? err.message : 'Could not connect.' });
      throw err;
    }
  };

  const startDemo = async (): Promise<void> => {
    teardown();
    const rt = createRuntime({
      seedPrice: 3312.4,
      tickIntervalMs: 400,
      seed: null,
      historyBars: 240,
      source: 'simulated',
      banner: 'Demo mode — simulated XAUUSD feed, no broker connected',
    });
    attach(rt);
    seedDemoAccounts(rt);
    rt.start();
    runtime = rt;
    emit({ type: 'snapshot', payload: rt.snapshot() });
    setSession({ status: 'demo' });
  };

  const signOut = async (): Promise<void> => {
    teardown();
    clearCredentials();
    setSession(LOCKED);
  };

  return {
    /* ---------------------------- streaming --------------------------- */

    subscribe(handlers: Subscription) {
      streamListeners.add(handlers);
      handlers.onStatus(session.status === 'live' || session.status === 'demo');
      if (runtime) handlers.onMessage({ type: 'snapshot', payload: runtime.snapshot() });
      return () => {
        streamListeners.delete(handlers);
      };
    },

    sessionState: () => session,

    onSession(listener) {
      sessionListeners.add(listener);
      listener(session);
      return () => {
        sessionListeners.delete(listener);
      };
    },

    connectBroker,
    startDemo,
    signOut,
    savedCredentials: () => loadCredentials(),

    /* ---------------------------- commands ---------------------------- */

    addAccount: async (payload: NewAccountPayload) =>
      addAccount(requireRuntime(), {
        name: payload.name,
        login: payload.login,
        server: payload.server,
        provider: payload.provider,
        role: payload.role,
        broker: payload.broker,
        leverage: payload.leverage,
        initialBalance: payload.initialBalance,
        metaApiAccountId: payload.metaApiAccountId,
        copy: payload.copy,
      }),

    updateAccount: async (
      id,
      patch: { name?: string; role?: AccountState['role']; copy?: Partial<CopySettings> },
    ) => updateAccount(requireRuntime(), id, patch),

    removeAccount: async (id) => removeAccount(requireRuntime(), id),

    order: async (payload: OrderPayload) =>
      placeOrder(requireRuntime(), payload) as Promise<{ opened: Position[]; errors: string[] }>,

    closePosition: async (id) => closePosition(requireRuntime(), id) as Promise<ClosedTrade>,

    closeAll: async (payload) => closeAll(requireRuntime(), payload),

    saveBotConfig: async (patch: Partial<BotConfig>) => updateBotConfig(requireRuntime(), patch),
    startBot: async () => startBot(requireRuntime()),
    stopBot: async (closePositions = false) => stopBot(requireRuntime(), closePositions),
  };
}
