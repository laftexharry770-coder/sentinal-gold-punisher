import type {
  AccountState,
  BotConfig,
  BotStats,
  ClosedTrade,
  CopySettings,
  Position,
  ServerMessage,
} from '@sentinal/shared';
import type { DerivCredentials, DerivMt5Account } from '../broker/derivClient';
import type { ConnectInput, SessionState } from './session';

export interface NewAccountPayload {
  name: string;
  login: string;
  server: string;
  provider: 'sim' | 'deriv';
  broker?: string;
  role: 'master' | 'slave' | 'standalone';
  leverage?: number;
  initialBalance?: number;
  copy?: Partial<CopySettings>;
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
  connectBroker(input: ConnectInput): Promise<void>;
  startDemo(): Promise<void>;
  signOut(): Promise<void>;
  savedCredentials(): DerivCredentials | null;

  /**
   * MetaTrader 5 accounts Deriv reports for this user. Read-only: Deriv's API
   * has no call that places an order on one.
   */
  mt5Accounts(): Promise<DerivMt5Account[]>;

  addAccount(payload: NewAccountPayload): Promise<AccountState>;
  updateAccount(
    id: string,
    patch: { name?: string; role?: AccountState['role']; copy?: Partial<CopySettings> },
  ): Promise<AccountState>;
  removeAccount(id: string): Promise<{ ok: boolean }>;

  order(payload: OrderPayload): Promise<{ opened: Position[]; errors: string[] }>;
  closePosition(id: string): Promise<ClosedTrade>;
  closeAll(payload: { accountId?: string; side?: 'buy' | 'sell'; profitableOnly?: boolean }): Promise<{
    closed: number;
  }>;

  saveBotConfig(patch: Partial<BotConfig>): Promise<BotView>;
  startBot(): Promise<BotView>;
  stopBot(closePositions?: boolean): Promise<BotView>;
}
