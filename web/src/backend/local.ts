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
import { registerSymbolSpec, XAUUSD } from '@sentinal/shared';
import {
  BrokerError,
  MetaApiClient,
  clearCredentials,
  goldCandidates,
  loadCredentials,
  saveCredentials,
  type BrokerCredentials,
} from '../broker/metaapiClient';
import { MetaApiBrowserAccount } from '../broker/metaapiAccount';
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
  let client: MetaApiClient | null = null;
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
    client = null;
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

      // Brokers name gold differently and quote it on their own contract terms,
      // so take the specification from this account rather than assuming one.
      const spec = await api.specification().catch(async (err: unknown) => {
        if (err instanceof BrokerError && err.status === 404) {
          const candidates = goldCandidates(await api.symbols().catch(() => []));
          throw new BrokerError(
            candidates.length > 0
              ? `${credentials.symbol} is not tradable on this account. This broker offers: ${candidates.join(', ')}.`
              : `${credentials.symbol} is not tradable on this account. Check the symbol name in your terminal.`,
            404,
          );
        }
        throw err;
      });

      registerSymbolSpec({
        symbol: spec.symbol,
        digits: spec.digits,
        tickSize: spec.tickSize,
        contractSize: spec.contractSize,
        minLot: spec.minLot,
        maxLot: spec.maxLot,
        lotStep: spec.lotStep,
        // Spread comes from the live quote; commission is not exposed per
        // symbol by MetaApi, so the built-in estimate stands until overridden.
        baseSpread: XAUUSD.baseSpread,
        commissionPerLot: XAUUSD.commissionPerLot,
      });
      credentials.symbol = spec.symbol;

      const rt = createRuntime({
        seedPrice: 0,
        tickIntervalMs: QUOTE_POLL_MS,
        seed: null,
        historyBars: 240,
        source: 'external',
        banner:
          `Connected to ${info.broker} · ${info.server} — live ${credentials.symbol} feed ` +
          `(${spec.contractSize} per lot, ${spec.digits} digits, ${spec.minLot} min lot)`,
      });
      attach(rt);
      runtime = rt;
      client = api;

      rt.bot.updateConfig({ symbol: credentials.symbol });

      // Real bars first, so the chart and the indicators open on broker history.
      const history = await api.history(240).catch(() => [] as Candle[]);
      if (history.length > 0) {
        rt.feed.seedCandles(history);
        rt.bot.prime(history);
      }

      if (input.liveExecution) {
        // Orders, closes and the position book come from the broker itself.
        rt.accounts.registerProvider(
          'metaapi',
          (cfg) => new MetaApiBrowserAccount(cfg, api, (message) => rt.journal.write('error', null, message)),
        );
      }

      addAccount(rt, {
        name: `${info.broker} ${info.login}`.trim(),
        provider: input.liveExecution ? 'metaapi' : 'sim',
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
            // Display the broker's own balance rather than a drifting local copy.
            for (const account of rt.accounts.list()) account.syncBalance(fresh.balance);
            emit({ type: 'accounts', payload: rt.accounts.states() });
            emit({ type: 'portfolio', payload: rt.accounts.portfolio() });
          })
          .catch(() => {
            /* transient; the quote poll surfaces persistent failures */
          });
      }, ACCOUNT_POLL_MS);

      if (input.remember) saveCredentials(credentials);
      else clearCredentials();

      rt.journal.write(
        input.liveExecution ? 'warn' : 'info',
        null,
        input.liveExecution
          ? 'Live execution armed — orders will be sent to your broker'
          : 'Paper execution — fills are simulated against your broker\'s prices',
      );

      setSession({
        status: 'live',
        broker: { login: info.login, server: info.server, broker: info.broker, currency: info.currency },
        execution: input.liveExecution ? 'broker' : 'local',
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

    // Only a live broker session has history to measure; demo mode has none.
    historyAround: async (from, to) => (client ? client.historyRange(from, to) : []),

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
