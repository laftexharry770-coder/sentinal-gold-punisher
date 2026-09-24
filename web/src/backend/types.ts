import type { LoadStrategyResult, MetaApiAccountSummary, ProvisionInput, StrategyFile } from '@sentinal/engine';
import type {
  AccountState,
  BotConfig,
  BotStats,
  ClosedTrade,
  CopySettings,
  Position,
  ServerMessage,
} from '@sentinal/shared';
import type { ConnectInput, SavedMetaApi, SessionState } from './session';

export type { MetaApiAccountSummary, ProvisionInput, StrategyFile };

export interface NewAccountPayload {
  name: string;
  login: string;
  server: string;
  provider: 'sim' | 'metaapi';
  broker?: string;
  role: 'master' | 'slave' | 'standalone';
  leverage?: number;
  initialBalance?: number;
  copy?: Partial<CopySettings>;
  metaApiId?: string;
  symbol?: string;
}

export interface OrderPayload {
  accountId?: string;
  symbol?: string;
  side: 'buy' | 'sell';
  volume: number;
  legs?: number;
  stopLossUsd?: number | null;
  takeProfitUsd?: number | null;
  comment?: string;
}

export interface BotView {
  config: BotConfig;
  stats: BotStats;
}

export interface Subscription {
  onMessage: (message: ServerMessage) => void;
  onStatus: (connected: boolean) => void;
}

/** A compile or load outcome the Strategy card can show as it is. */
export type StrategyLoadOutcome = LoadStrategyResult;

/**
 * Everything the terminal needs from its execution host.
 *
 * Two implementations exist: one talking to the Node server over REST and a
 * WebSocket, one running the engine inside the browser tab. The screens are
 * written against this interface and are identical in both builds.
 */
export interface TerminalBackend {
  /** Starts streaming. Returns an unsubscribe function. */
  subscribe(handlers: Subscription): () => void;

  /* --- session: the terminal shows market data only once this is live --- */
  sessionState(): SessionState;
  onSession(listener: (state: SessionState) => void): () => void;
  /** The MetaTrader accounts a MetaApi token can reach. */
  listMetaApiAccounts(token: string): Promise<MetaApiAccountSummary[]>;
  /** Adds a MetaTrader login to the token's MetaApi account. */
  provisionMetaApiAccount(token: string, input: ProvisionInput): Promise<MetaApiAccountSummary>;
  connectBroker(input: ConnectInput): Promise<void>;
  startDemo(): Promise<void>;
  signOut(): Promise<void>;
  savedCredentials(): SavedMetaApi | null;

  /* --- accounts --- */
  addAccount(payload: NewAccountPayload): Promise<AccountState>;
  /** Links another MetaApi account of the signed-in token as a follower. */
  addMetaApiFollower(metaApiId: string, copy: Partial<CopySettings>): Promise<AccountState>;
  updateAccount(
    id: string,
    patch: { name?: string; role?: AccountState['role']; copy?: Partial<CopySettings> },
  ): Promise<AccountState>;
  removeAccount(id: string): Promise<{ ok: boolean }>;
  /** Switches an account's MetaApi quote stream to every tick. */
  streamEveryTick(id: string): Promise<void>;

  /* --- trading --- */
  order(payload: OrderPayload): Promise<{ opened: Position[]; errors: string[] }>;
  closePosition(id: string): Promise<ClosedTrade>;
  closeAll(payload: { accountId?: string; side?: 'buy' | 'sell'; profitableOnly?: boolean }): Promise<{
    closed: number;
  }>;

  /* --- strategy --- */
  saveBotConfig(patch: Partial<BotConfig>): Promise<BotView>;
  startBot(): Promise<BotView>;
  stopBot(closePositions?: boolean): Promise<BotView>;
  /** Makes uploaded .mq5 (+ .mqh) or .ex5 files the strategy. */
  loadStrategy(files: StrategyFile[]): Promise<StrategyLoadOutcome>;
  /** Back to the built-in models. */
  useBuiltinStrategy(strategy?: BotConfig['strategy']): Promise<BotView>;
  /** New EA inputs or chart timeframe; a running EA restarts with them. */
  configureExpert(patch: { inputs?: Record<string, string | number | boolean>; timeframe?: number }): Promise<BotView>;
}
