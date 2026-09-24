import type { AddedExpert, LoadStrategyResult, MetaApiAccountSummary, ProvisionInput, StrategyFile } from '@sentinal/engine';
import type {
  AccountState,
  AiReview,
  BotConfig,
  BotStats,
  ClosedTrade,
  CopySettings,
  Position,
  ServerMessage,
} from '@sentinal/shared';
import type { ConnectInput, SavedMetaApi, SessionState } from './session';

export type { AddedExpert, MetaApiAccountSummary, ProvisionInput, StrategyFile };

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

/** Where Claude's API key lives: this browser, or the execution server's environment. */
export interface ClaudeKeyState {
  where: 'browser' | 'server';
  configured: boolean;
}

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

  /* --- strategy: the built-in model, and the EA library beside it --- */
  saveBotConfig(patch: Partial<BotConfig>): Promise<BotView>;
  startBot(): Promise<BotView>;
  stopBot(closePositions?: boolean): Promise<BotView>;
  /** The built-in model that trades beside the EAs switched on; 'none' leaves it to the EAs. */
  useBuiltinStrategy(strategy: BotConfig['strategy']): Promise<BotView>;
  /** Adds .mq5 (+ .mqh) and .ex5 files to the library — several at once, switched on unless told otherwise. */
  addExperts(files: StrategyFile[], options?: { enabled?: boolean }): Promise<AddedExpert[]>;
  /** Switches an EA on or off; with the bot running it starts or stops at once. */
  setExpertEnabled(id: string, enabled: boolean): Promise<void>;
  /** New inputs or chart timeframe for one EA; a running one restarts with them. */
  configureExpert(id: string, patch: { inputs?: Record<string, string | number | boolean>; timeframe?: number }): Promise<void>;
  removeExpert(id: string): Promise<void>;

  /* --- the AI and Claude's reviews of it --- */
  /** Asks Claude to review the AI now; null when it cannot (no key, one already running). */
  reviewAi(): Promise<AiReview | null>;
  approveAiSuggestion(): Promise<void>;
  dismissAiSuggestion(): Promise<void>;
  /** Lifts a pause Claude set on the AI's entries. */
  resumeAi(): Promise<void>;
  claudeKey(): ClaudeKeyState;
  /** Keeps (or with null forgets) the Anthropic API key; only the browser build can. */
  setClaudeKey(key: string | null): Promise<void>;
}
