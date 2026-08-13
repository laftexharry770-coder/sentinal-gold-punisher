import type { DerivCredentials, TradingMode } from '../broker/derivClient';

export interface BrokerIdentity {
  login: string;
  server: string;
  broker: string;
  currency: string;
}

export type SessionState =
  /** No broker session: the terminal shows the sign-in screen and no market data. */
  | { status: 'locked'; error: string | null }
  | { status: 'connecting'; error: null }
  /** Live broker data. `execution` says where orders actually go. */
  | { status: 'live'; broker: BrokerIdentity; execution: 'broker' | 'local'; mode: TradingMode }
  /** Explicitly chosen simulation — labelled as such everywhere. */
  | { status: 'demo' };

export const LOCKED: SessionState = { status: 'locked', error: null };

export interface ConnectInput extends DerivCredentials {
  remember: boolean;
  /**
   * Opt-in: when true the engine buys real Deriv contracts. Off by default so
   * connecting to watch prices can never place a trade.
   */
  liveExecution: boolean;
}
