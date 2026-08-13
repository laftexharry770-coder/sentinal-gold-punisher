import type {
  AccountState,
  BotConfig,
  BotStats,
  ClosedTrade,
  CopySettings,
  Position,
  ServerMessage,
} from '@sentinal/shared';
import type {
  DerivCredentials,
  DerivDigitContract,
  DerivMt5Account,
  DerivSymbolInfo,
} from '../broker/derivClient';
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

export interface DigitOrder {
  symbol: string;
  contract: DerivDigitContract;
  barrier: number;
  stake: number;
  ticks: number;
  currency: string;
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

  /**
   * Confirms an MT5 login and password with Deriv. Resolves when Deriv accepts
   * them; it proves the account is yours but grants no way to trade it.
   */
  verifyMt5(login: string, password: string, kind: 'main' | 'investor'): Promise<void>;

  /* --- digits desk: synthetic indices and their digit contracts --- */

  /** The synthetic indices digit contracts trade on. */
  digitSymbols(): Promise<DerivSymbolInfo[]>;
  /** Streams one symbol's quotes. Resolves with the way to stop. */
  streamDigits(symbol: string, handler: (quote: number, epoch: number) => void): Promise<() => void>;
  /** What Deriv would pay for a contract, asked before it is bought. */
  digitProposal(input: DigitOrder): Promise<{ payout: number; askPrice: number; longcode: string }>;
  /** Buys a digit contract. */
  buyDigit(input: DigitOrder): Promise<{ contractId: string; buyPrice: number; payout: number; longcode: string }>;

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
