export interface BrokerIdentity {
  /** The MetaTrader login. */
  login: string;
  server: string;
  /** The broker's own name, as MetaTrader reports it. */
  broker: string;
  currency: string;
  accountType: 'demo' | 'real' | 'contest' | 'sim';
  platform: 'mt4' | 'mt5' | 'sim';
  /** The master's MetaApi account id. */
  metaApiId: string | null;
}

export type SessionState =
  /** No broker session: the terminal shows the sign-in screen and no market data. */
  | { status: 'locked'; error: string | null }
  | { status: 'connecting'; error: null; step: string }
  /** Live broker data. `execution` says where orders actually go. */
  | { status: 'live'; broker: BrokerIdentity; execution: 'broker' | 'local' }
  /** Explicitly chosen simulation — labelled as such everywhere. */
  | { status: 'demo' };

export const LOCKED: SessionState = { status: 'locked', error: null };

/** What the browser keeps between visits when "stay signed in" is on. */
export interface SavedMetaApi {
  token: string;
  masterId: string;
  followerIds: string[];
  symbol: string;
}

export interface ConnectInput extends SavedMetaApi {
  remember: boolean;
  /**
   * Opt-in: when true the engine sends real orders to MetaTrader. Off by
   * default so connecting to watch the market can never place a trade.
   */
  liveExecution: boolean;
  /** Lot multiplier for followers linked at sign-in. */
  followerMultiplier: number;
}
