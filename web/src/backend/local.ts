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
import type {
  BotView,
  NewAccountPayload,
  OrderPayload,
  Subscription,
  TerminalBackend,
} from './types';

/**
 * Runs the whole execution engine inside the browser tab.
 *
 * This is what the standalone build uses: identical engine, identical command
 * layer, no server. The only capability it cannot offer is MetaApi routing,
 * which needs a server-held token.
 */
export function createLocalBackend(): TerminalBackend {
  let runtime: Runtime | null = null;

  const boot = (): Runtime => {
    if (runtime) return runtime;
    runtime = createRuntime({
      seedPrice: 3312.4,
      tickIntervalMs: 400,
      seed: null,
      historyBars: 240,
      banner: 'Sentinal MT5 running in-browser — simulated XAUUSD feed live',
    });
    seedDemoAccounts(runtime);
    runtime.start();
    return runtime;
  };

  /** Commands throw CommandError; surface the message the same way REST does. */
  const run = async <T>(fn: () => T | Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      throw err instanceof Error ? err : new Error(String(err));
    }
  };

  return {
    subscribe({ onMessage, onStatus }: Subscription) {
      const rt = boot();
      let lastBookPush = 0;
      let disposed = false;

      const send = (message: ServerMessage) => {
        if (!disposed) onMessage(message);
      };

      const pushBook = () => {
        send({ type: 'positions', payload: rt.accounts.allPositions() });
        send({ type: 'accounts', payload: rt.accounts.states() });
        send({ type: 'portfolio', payload: rt.accounts.portfolio() });
      };

      const onTick = (payload: unknown) => {
        const tick = payload as Tick;
        send({ type: 'tick', payload: tick });
        // The book is pushed on a slower cadence than the quote, matching the
        // server's frame budget.
        if (tick.time - lastBookPush >= 500) {
          lastBookPush = tick.time;
          pushBook();
        }
      };
      const onCandle = (payload: unknown) =>
        send({ type: 'candle', payload: payload as { candle: Candle; closed: boolean } });
      const onEquity = (payload: unknown) => send({ type: 'equity', payload: payload as EquityPoint });
      const onLog = (payload: unknown) => send({ type: 'log', payload: payload as LogEntry });
      const onAccounts = (payload: unknown) => send({ type: 'accounts', payload: payload as AccountState[] });
      const onOpened = () => {
        send({ type: 'positions', payload: rt.accounts.allPositions() });
        send({ type: 'accounts', payload: rt.accounts.states() });
      };
      const onClosed = () => {
        send({ type: 'positions', payload: rt.accounts.allPositions() });
        send({ type: 'history', payload: rt.accounts.allHistory() });
        send({ type: 'accounts', payload: rt.accounts.states() });
        send({ type: 'portfolio', payload: rt.accounts.portfolio() });
      };
      const onBot = (payload: unknown) => send({ type: 'bot', payload: payload as BotView });
      const onRecoveries = (payload: unknown) =>
        send({ type: 'recoveries', payload: payload as RecoveryTask[] });

      rt.feed.on('tick', onTick);
      rt.feed.on('candle', onCandle);
      rt.feed.on('equity', onEquity);
      rt.journal.on('log', onLog);
      rt.accounts.on('accounts', onAccounts);
      rt.accounts.on('opened', onOpened);
      rt.accounts.on('closed', onClosed);
      rt.bot.on('bot', onBot);
      rt.bot.on('recoveries', onRecoveries);

      send({ type: 'snapshot', payload: rt.snapshot() });
      onStatus(true);

      return () => {
        disposed = true;
        rt.feed.off('tick', onTick);
        rt.feed.off('candle', onCandle);
        rt.feed.off('equity', onEquity);
        rt.journal.off('log', onLog);
        rt.accounts.off('accounts', onAccounts);
        rt.accounts.off('opened', onOpened);
        rt.accounts.off('closed', onClosed);
        rt.bot.off('bot', onBot);
        rt.bot.off('recoveries', onRecoveries);
        onStatus(false);
      };
    },

    addAccount: (payload: NewAccountPayload) =>
      run<AccountState>(() =>
        addAccount(boot(), {
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
      ),

    updateAccount: (id, patch: { name?: string; role?: AccountState['role']; copy?: Partial<CopySettings> }) =>
      run<AccountState>(() => updateAccount(boot(), id, patch)),

    removeAccount: (id) => run<{ ok: boolean }>(() => removeAccount(boot(), id)),

    order: (payload: OrderPayload) =>
      run<{ opened: Position[]; errors: string[] }>(() => placeOrder(boot(), payload)),

    closePosition: (id) => run<ClosedTrade>(() => closePosition(boot(), id)),

    closeAll: (payload) => run<{ closed: number }>(() => closeAll(boot(), payload)),

    saveBotConfig: (patch: Partial<BotConfig>) => run<BotView>(() => updateBotConfig(boot(), patch)),
    startBot: () => run<BotView>(() => startBot(boot())),
    stopBot: (closePositions = false) => run<BotView>(() => stopBot(boot(), closePositions)),
  };
}
