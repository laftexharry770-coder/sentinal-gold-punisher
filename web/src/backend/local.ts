import {
  CommandError,
  MetaApiAccount,
  MetaApiGateway,
  addAccount,
  addExperts,
  addMetaApiFollower,
  attachMetaApi,
  closeAll,
  closePosition,
  configureExpert,
  createClaudeReviewer,
  createRuntime,
  placeOrder,
  removeAccount,
  removeExpert,
  seedDemoAccounts,
  setExpertEnabled,
  startBot,
  stopBot,
  updateAccount,
  updateBotConfig,
  useBuiltinStrategy,
  type AiReviewClient,
  type MetaApiLink,
  type Runtime,
  type RuntimeOptions,
  type StrategyFile,
} from '@sentinal/engine';
import type {
  AccountState,
  AiStatus,
  BotConfig,
  Candle,
  ClosedTrade,
  CopySettings,
  DispatchReport,
  EquityPoint,
  ExpertSlot,
  LogEntry,
  PendingOrder,
  RecoveryTask,
  ServerMessage,
  StrategyInfo,
  Tick,
} from '@sentinal/shared';
import { ANGEL_BOT } from '../bundledStrategies';
import { browserLibraryStore } from './library';
import { createMetaApiClient, explainMetaApiError } from './metaapiSdk';
import {
  angelSeeded,
  loadAiModel,
  loadBotConfig,
  loadClaudeKey,
  loadMetaApiCredentials,
  markAngelSeeded,
  saveAiModel,
  saveBotConfig,
  saveClaudeKey,
  saveMetaApiCredentials,
  takeLegacyStrategy,
} from './persist';
import { LOCKED, type ConnectInput, type SessionState } from './session';
import type { BotView, NewAccountPayload, OrderPayload, Subscription, TerminalBackend } from './types';

/**
 * Runs the engine inside the browser tab.
 *
 * Nothing starts until a session exists: no feed, no accounts, no prices. A
 * MetaApi session drives the feed from the master account's own quotes, sends
 * orders straight to MetaTrader, and keeps every follower on its own
 * streaming connection so a copy leaves the moment the master's order does.
 * Demo mode is an explicit choice and is labelled as simulated throughout.
 */
export function createLocalBackend(): TerminalBackend {
  let runtime: Runtime | null = null;
  let session: SessionState = LOCKED;
  let gateway: MetaApiGateway | null = null;
  let link: MetaApiLink | null = null;
  /** Gateways opened for listing accounts before sign-in, by token. */
  const gateways = new Map<string, Promise<MetaApiGateway>>();

  /** Claude, built once per key — the key never leaves this browser except to Anthropic. */
  let reviewer: { key: string; client: AiReviewClient } | null = null;
  const reviewerNow = (): AiReviewClient | null => {
    const key = loadClaudeKey();
    if (!key) return null;
    if (reviewer?.key !== key) reviewer = { key, client: createClaudeReviewer(key, { browser: true }) };
    return reviewer.client;
  };
  /** What every runtime in this tab keeps between visits: the EA library, the AI's model, Claude. */
  const persistence = (): Pick<RuntimeOptions, 'library' | 'aiStore' | 'aiReviewer'> => ({
    library: browserLibraryStore(),
    aiStore: { load: loadAiModel, save: saveAiModel },
    aiReviewer: reviewerNow,
  });

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

  const gatewayFor = (token: string): Promise<MetaApiGateway> => {
    const key = token.trim();
    let pending = gateways.get(key);
    if (!pending) {
      pending = createMetaApiClient(key).then((client) => new MetaApiGateway(client));
      gateways.set(key, pending);
      pending.catch(() => gateways.delete(key));
    }
    return pending;
  };

  /** Wires a fresh runtime's events onto the message stream. */
  const attach = (rt: Runtime): void => {
    let lastBookPush = 0;
    let bookTimer: ReturnType<typeof setTimeout> | null = null;
    // Broker accounts change between ticks (fills, balance, reconnects), so
    // their changes are batched into one push per frame rather than lost.
    const scheduleBook = (): void => {
      if (bookTimer) return;
      bookTimer = setTimeout(() => {
        bookTimer = null;
        if (runtime === rt) pushBook(rt);
      }, 120);
    };

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
    rt.accounts.on('accounts', (payload: unknown) => emit({ type: 'accounts', payload: payload as AccountState[] }));
    rt.accounts.on('changed', scheduleBook);
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
    rt.accounts.on('partial', () => emit({ type: 'history', payload: rt.accounts.allHistory() }));
    rt.accounts.on('orders', (payload: unknown) => emit({ type: 'orders', payload: payload as PendingOrder[] }));
    rt.bot.on('bot', (payload: unknown) => {
      const view = payload as BotView;
      emit({ type: 'bot', payload: view });
      saveBotConfig(view.config);
    });
    rt.bot.on('recoveries', (payload: unknown) => emit({ type: 'recoveries', payload: payload as RecoveryTask[] }));
    rt.bot.on('strategy', (payload: unknown) => emit({ type: 'strategy', payload: payload as StrategyInfo }));
    rt.bot.on('experts', (payload: unknown) => emit({ type: 'experts', payload: payload as ExpertSlot[] }));
    rt.bot.on('ai', (payload: unknown) => emit({ type: 'ai', payload: payload as AiStatus }));
    rt.copier.on('dispatch', (payload: unknown) => emit({ type: 'dispatch', payload: payload as DispatchReport }));
  };

  /**
   * Settings and the EA library from the last visit, so a reload picks up
   * where it left off. The settings are read before the runtime exists: the
   * broker's first events save the defaults, which must not win over them.
   */
  const restore = async (rt: Runtime, config: ReturnType<typeof loadBotConfig>): Promise<void> => {
    if (config) {
      const { source: _source, expertInputs: _inputs, expertTimeframe: _timeframe, ...rest } = config;
      rt.bot.updateConfig({ ...rest, enabled: false });
    }
    try {
      await rt.experts.restore();
      // The one EA an earlier version kept moves into the library, with its inputs.
      const legacy = takeLegacyStrategy();
      if (legacy && rt.experts.size === 0) {
        await addExperts(rt, legacy.files, { enabled: legacy.active, inputs: config?.expertInputs ?? {}, timeframe: config?.expertTimeframe ?? 1 });
        // It was the strategy in use: it trades alone, as it did.
        if (legacy.active && config?.source && config.source !== 'builtin') rt.bot.updateConfig({ strategy: 'none' });
      }
      // Angel Bot ships with the terminal: in the library once, switched off, until removed.
      if (!angelSeeded()) {
        if (!rt.experts.idOf(ANGEL_BOT.name)) await addExperts(rt, [ANGEL_BOT], { enabled: false, bundled: true });
        markAngelSeeded();
      }
    } catch (err) {
      rt.journal.write('warn', null, `The EA library could not be restored: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const teardown = (): void => {
    link?.detach();
    link = null;
    runtime?.stop();
    runtime = null;
    gateway = null;
  };

  const requireRuntime = (): Runtime => {
    if (!runtime) throw new Error('Connect a MetaTrader account before trading.');
    return runtime;
  };

  /* ------------------------------------------------------------------ */
  /* Sessions                                                            */
  /* ------------------------------------------------------------------ */

  const connectBroker = async (input: ConnectInput): Promise<void> => {
    teardown();
    const savedConfig = loadBotConfig();
    const token = input.token.trim();
    setSession({ status: 'connecting', error: null, step: 'Opening MetaApi' });

    try {
      if (!input.masterId) throw new Error('Choose the master account.');
      gateway = await gatewayFor(token);

      const rt = createRuntime({
        seedPrice: 0,
        tickIntervalMs: 1000,
        seed: null,
        historyBars: 240,
        source: 'external',
        ...persistence(),
      });
      attach(rt);
      runtime = rt;

      const summaries = await gateway.listAccounts();
      const master = summaries.find((s) => s.id === input.masterId);
      if (!master) throw new Error('That master account is no longer on this MetaApi token.');
      setSession({
        status: 'connecting',
        error: null,
        step: master.state === 'DEPLOYED' ? `Synchronising ${master.login} on ${master.server}` : `Starting MetaApi's server for ${master.login} — up to a minute`,
      });

      link = await attachMetaApi(rt, gateway, {
        masterId: input.masterId,
        followerIds: input.followerIds,
        symbol: input.symbol,
        paper: !input.liveExecution,
        followerCopy: { sizing: 'multiplier', multiplier: input.followerMultiplier > 0 ? input.followerMultiplier : 1 },
      });
      const state = link.master.state();
      rt.journal.write(
        'info',
        link.master.id,
        `Connected to ${state.broker} · ${state.login} (${state.accountType}) — live ${link.master.symbol} feed through MetaApi`,
      );

      await restore(rt, savedConfig);
      emit({ type: 'snapshot', payload: rt.snapshot() });

      saveMetaApiCredentials(
        input.remember ? { token, masterId: input.masterId, followerIds: input.followerIds, symbol: input.symbol } : null,
      );

      rt.journal.write(
        input.liveExecution ? 'warn' : 'info',
        null,
        input.liveExecution
          ? `Live execution armed — orders go to MetaTrader on ${state.login} and ${link.followers.length} follower(s)`
          : "Paper execution — fills are simulated against your broker's real quotes; nothing reaches MetaTrader",
      );

      setSession({
        status: 'live',
        broker: {
          login: state.login,
          server: state.server,
          broker: state.broker,
          currency: state.currency,
          accountType: state.accountType,
          platform: state.platform,
          metaApiId: state.metaApiId,
        },
        execution: input.liveExecution ? 'broker' : 'local',
      });
    } catch (err) {
      teardown();
      const message = explainMetaApiError(err);
      setSession({ status: 'locked', error: message });
      throw new Error(message);
    }
  };

  const startDemo = async (): Promise<void> => {
    teardown();
    const savedConfig = loadBotConfig();
    const rt = createRuntime({
      seedPrice: 3312.4,
      tickIntervalMs: 400,
      seed: null,
      historyBars: 240,
      source: 'simulated',
      banner: 'Demo mode — simulated XAUUSD feed, no broker connected',
      ...persistence(),
    });
    attach(rt);
    seedDemoAccounts(rt);
    rt.start();
    runtime = rt;
    await restore(rt, savedConfig);
    emit({ type: 'snapshot', payload: rt.snapshot() });
    setSession({ status: 'demo' });
  };

  const signOut = async (): Promise<void> => {
    teardown();
    for (const pending of gateways.values()) void pending.then((g) => g.close()).catch(() => undefined);
    gateways.clear();
    saveMetaApiCredentials(null);
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

    listMetaApiAccounts: async (token) => {
      try {
        // An empty token asks for the signed-in session's own accounts.
        const gw = token.trim() ? await gatewayFor(token) : gateway;
        if (!gw) throw new Error('Sign in with a MetaApi token first.');
        return await gw.listAccounts();
      } catch (err) {
        if (token.trim()) gateways.delete(token.trim());
        throw new Error(explainMetaApiError(err));
      }
    },

    provisionMetaApiAccount: async (token, input) => {
      try {
        return await (await gatewayFor(token)).provision(input);
      } catch (err) {
        throw new Error(explainMetaApiError(err));
      }
    },

    connectBroker,
    startDemo,
    signOut,
    savedCredentials: () => loadMetaApiCredentials(),

    /* ----------------------------- accounts ---------------------------- */

    addAccount: async (payload: NewAccountPayload) => addAccount(requireRuntime(), payload),

    addMetaApiFollower: async (metaApiId: string, copy: Partial<CopySettings>) => {
      const rt = requireRuntime();
      if (!gateway || !link) throw new Error('Followers from MetaApi need a MetaApi session.');
      return (await addMetaApiFollower(rt, gateway, link, metaApiId, copy)).state();
    },

    updateAccount: async (id, patch: { name?: string; role?: AccountState['role']; copy?: Partial<CopySettings> }) =>
      updateAccount(requireRuntime(), id, patch),

    removeAccount: async (id) => {
      const rt = requireRuntime();
      if (link && link.master.id === id) {
        throw new CommandError('The master is the session itself — sign out to change it.');
      }
      if (link) link.followers = link.followers.filter((f) => f.id !== id);
      return removeAccount(rt, id);
    },

    streamEveryTick: async (id) => {
      const account = requireRuntime().accounts.get(id);
      if (!(account instanceof MetaApiAccount)) throw new Error('Only MetaApi accounts stream quotes.');
      await account.streamEveryTick();
    },

    /* ----------------------------- trading ----------------------------- */

    order: async (payload: OrderPayload) => placeOrder(requireRuntime(), payload),

    closePosition: async (id) => closePosition(requireRuntime(), id) as Promise<ClosedTrade>,

    closeAll: async (payload) => closeAll(requireRuntime(), payload),

    /* ----------------------------- strategy ---------------------------- */

    saveBotConfig: async (patch: Partial<BotConfig>) => updateBotConfig(requireRuntime(), patch),
    startBot: async () => startBot(requireRuntime()),
    stopBot: async (closePositions = false) => stopBot(requireRuntime(), closePositions),

    useBuiltinStrategy: async (strategy) => useBuiltinStrategy(requireRuntime(), strategy),

    addExperts: async (files: StrategyFile[], options = {}) => addExperts(requireRuntime(), files, options),

    setExpertEnabled: async (id, enabled) => {
      await setExpertEnabled(requireRuntime(), id, enabled);
    },

    configureExpert: async (id, patch) => {
      await configureExpert(requireRuntime(), id, patch);
    },

    removeExpert: async (id) => {
      await removeExpert(requireRuntime(), id);
    },

    /* -------------------------------- AI ------------------------------- */

    reviewAi: async () => requireRuntime().ai.review('request'),
    approveAiSuggestion: async () => {
      requireRuntime().ai.approvePending();
    },
    dismissAiSuggestion: async () => {
      requireRuntime().ai.dismissPending();
    },
    resumeAi: async () => {
      requireRuntime().ai.resume();
    },
    claudeKey: () => ({ where: 'browser', configured: loadClaudeKey() !== null }),
    setClaudeKey: async (key) => {
      saveClaudeKey(key);
      runtime?.ai.publish();
    },
  };
}
