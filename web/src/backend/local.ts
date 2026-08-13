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
  CONTRACT_SIZE,
  DEFAULT_SYMBOL,
  DerivClient,
  clearCredentials,
  goldCandidates,
  loadCredentials,
  saveCredentials,
  type DerivCredentials,
} from '../broker/derivClient';
import { DerivBrowserAccount } from '../broker/derivAccount';
import { LOCKED, type ConnectInput, type SessionState } from './session';
import type {
  BotView,
  NewAccountPayload,
  OrderPayload,
  Subscription,
  TerminalBackend,
} from './types';

/**
 * Runs the engine inside the browser tab.
 *
 * Nothing starts until a session exists: no feed, no accounts, no prices. A
 * Deriv session drives the feed from real Deriv ticks; demo mode is an explicit
 * choice and is labelled as simulated throughout the UI.
 */
export function createLocalBackend(): TerminalBackend {
  let runtime: Runtime | null = null;
  let session: SessionState = LOCKED;
  let client: DerivClient | null = null;

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
    client?.close();
    client = null;
    runtime?.stop();
    runtime = null;
  };

  const requireRuntime = (): Runtime => {
    if (!runtime) throw new Error('Connect your Deriv account before trading.');
    return runtime;
  };

  /* ------------------------------------------------------------------ */
  /* Sessions                                                            */
  /* ------------------------------------------------------------------ */

  const connectBroker = async (input: ConnectInput): Promise<void> => {
    teardown();
    setSession({ status: 'connecting', error: null });

    const credentials: DerivCredentials = {
      token: input.token.trim(),
      appId: input.appId.trim(),
      symbol: input.symbol.trim() || DEFAULT_SYMBOL,
      multiplier: input.multiplier,
    };

    try {
      const api = new DerivClient(credentials);
      // Authorising first means a bad token never leaves a half-built terminal.
      const info = await api.open((reason) => {
        setSession({ status: 'locked', error: reason });
        teardown();
      });
      client = api;

      // Deriv names its instruments its own way and quotes them to its own
      // precision, so take the pip size from the account rather than assuming.
      const symbols = await api.activeSymbols().catch(() => []);
      const listed = symbols.find((entry) => entry.symbol === credentials.symbol);
      if (symbols.length > 0 && !listed) {
        const candidates = goldCandidates(symbols);
        throw new BrokerError(
          candidates.length > 0
            ? `${credentials.symbol} is not tradable on this account. Deriv offers: ${candidates.join(', ')}.`
            : `${credentials.symbol} is not tradable on this account.`,
          'UnknownSymbol',
        );
      }

      const pip = listed && listed.pip > 0 ? listed.pip : 0.01;
      const digits = Math.max(0, Math.round(-Math.log10(pip)));

      // Multiplier terms decide what a lot costs, so they are read before the
      // engine is built rather than discovered on the first rejected order.
      const terms = await api.multiplierTerms(credentials.symbol).catch(() => null);
      if (input.liveExecution && !terms) {
        throw new BrokerError(
          `This Deriv account cannot trade multiplier contracts on ${credentials.symbol}. ` +
            'Connect without live execution to watch prices, or use an account whose landing company offers multipliers.',
          'NoMultipliers',
        );
      }
      if (terms && !terms.multipliers.includes(credentials.multiplier)) {
        const nearest = terms.multipliers.reduce((best, value) =>
          Math.abs(value - credentials.multiplier) < Math.abs(best - credentials.multiplier) ? value : best,
        );
        credentials.multiplier = nearest;
      }

      registerSymbolSpec({
        symbol: credentials.symbol,
        digits,
        tickSize: pip,
        // Deriv stakes in currency rather than lots; 100 oz per lot is the
        // MetaTrader convention this terminal converts to and from.
        contractSize: CONTRACT_SIZE,
        minLot: 0.01,
        maxLot: 100,
        lotStep: 0.01,
        // Deriv publishes a single quote and charges a commission on the
        // contract instead of widening the price, so there is no spread here.
        baseSpread: 0,
        commissionPerLot: XAUUSD.commissionPerLot,
      });

      const account = info.isVirtual ? 'Deriv demo account' : 'Deriv real account';
      const rt = createRuntime({
        seedPrice: 0,
        tickIntervalMs: 1000,
        seed: null,
        historyBars: 240,
        source: 'external',
        banner:
          `Connected to ${info.landingCompany} · ${info.loginId} (${account}) — live ` +
          `${listed?.displayName ?? credentials.symbol} feed` +
          (terms ? ` · multiplier ${credentials.multiplier}×, min stake ${terms.minStake} ${info.currency}` : ''),
      });
      attach(rt);
      runtime = rt;

      rt.bot.updateConfig({ symbol: credentials.symbol });

      // Real bars first, so the chart and the indicators open on Deriv history.
      const history = await api.history(240).catch(() => [] as Candle[]);
      if (history.length > 0) {
        rt.feed.seedCandles(history);
        rt.bot.prime(history);
      }

      if (input.liveExecution && terms) {
        // Orders, closes and the position book come from Deriv itself.
        rt.accounts.registerProvider(
          'deriv',
          (cfg) =>
            new DerivBrowserAccount(cfg, api, credentials.multiplier, terms.minStake, (message) =>
              rt.journal.write('error', null, message),
            ),
        );
      }

      addAccount(rt, {
        name: `${info.landingCompany} ${info.loginId}`.trim(),
        provider: input.liveExecution && terms ? 'deriv' : 'sim',
        login: info.loginId,
        server: info.isVirtual ? 'Deriv (virtual)' : 'Deriv',
        broker: info.landingCompany,
        currency: info.currency,
        // Multiplier contracts carry their leverage in the multiplier itself.
        leverage: credentials.multiplier,
        initialBalance: info.balance,
        role: 'master',
      });

      await api.subscribeTicks((tick) => rt.feed.pushTick(tick));
      await api
        .subscribeBalance((balance) => {
          // Display Deriv's own balance rather than a drifting local copy.
          for (const acc of rt.accounts.list()) acc.syncBalance(balance);
          emit({ type: 'accounts', payload: rt.accounts.states() });
          emit({ type: 'portfolio', payload: rt.accounts.portfolio() });
        })
        .catch(() => {
          rt.journal.write('warn', null, 'Deriv refused the balance stream; balance may lag.');
        });

      emit({ type: 'snapshot', payload: rt.snapshot() });

      if (input.remember) saveCredentials(credentials);
      else clearCredentials();

      rt.journal.write(
        input.liveExecution && terms ? 'warn' : 'info',
        null,
        input.liveExecution && terms
          ? `Live execution armed — the bot will buy real ${credentials.multiplier}× multiplier contracts`
          : "Paper execution — fills are simulated against Deriv's real prices",
      );

      setSession({
        status: 'live',
        broker: {
          login: info.loginId,
          server: info.isVirtual ? 'Deriv (virtual)' : 'Deriv',
          broker: info.landingCompany,
          currency: info.currency,
        },
        execution: input.liveExecution && terms ? 'broker' : 'local',
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
