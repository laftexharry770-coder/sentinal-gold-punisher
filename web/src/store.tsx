import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  type ReactNode,
} from 'react';
import {
  DEFAULT_BOT_CONFIG,
  type AccountState,
  type BotConfig,
  type BotStats,
  type Candle,
  type ClosedTrade,
  type EquityPoint,
  type LogEntry,
  type PortfolioSnapshot,
  type Position,
  type RecoveryTask,
  type ServerMessage,
  type Tick,
} from '@sentinal/shared';

export interface TerminalState {
  connected: boolean;
  quote: Tick | null;
  previousQuote: Tick | null;
  candles: Candle[];
  accounts: AccountState[];
  positions: Position[];
  history: ClosedTrade[];
  logs: LogEntry[];
  recoveries: RecoveryTask[];
  config: BotConfig;
  stats: BotStats | null;
  portfolio: PortfolioSnapshot | null;
  equityCurve: EquityPoint[];
}

const EMPTY: TerminalState = {
  connected: false,
  quote: null,
  previousQuote: null,
  candles: [],
  accounts: [],
  positions: [],
  history: [],
  logs: [],
  recoveries: [],
  config: DEFAULT_BOT_CONFIG,
  stats: null,
  portfolio: null,
  equityCurve: [],
};

type Action = { type: 'connection'; connected: boolean } | { type: 'message'; message: ServerMessage };

function applyCandle(candles: Candle[], candle: Candle): Candle[] {
  const next = [...candles];
  const last = next[next.length - 1];
  if (last && last.time === candle.time) next[next.length - 1] = candle;
  else next.push(candle);
  return next.length > 320 ? next.slice(-320) : next;
}

function reduce(state: TerminalState, action: Action): TerminalState {
  if (action.type === 'connection') return { ...state, connected: action.connected };

  const message = action.message;
  switch (message.type) {
    case 'snapshot': {
      const p = message.payload;
      return {
        ...state,
        connected: true,
        quote: p.quote,
        previousQuote: null,
        candles: p.candles,
        accounts: p.accounts,
        positions: p.positions,
        history: p.history,
        logs: p.logs,
        recoveries: p.recoveries,
        config: p.bot,
        stats: p.stats,
        portfolio: p.portfolio,
        equityCurve: p.equityCurve,
      };
    }
    case 'tick':
      return { ...state, previousQuote: state.quote, quote: message.payload };
    case 'candle':
      return { ...state, candles: applyCandle(state.candles, message.payload.candle) };
    case 'accounts':
      return { ...state, accounts: message.payload };
    case 'positions':
      return { ...state, positions: message.payload };
    case 'history':
      return { ...state, history: message.payload };
    case 'log':
      return { ...state, logs: [message.payload, ...state.logs].slice(0, 400) };
    case 'recoveries':
      return { ...state, recoveries: message.payload };
    case 'bot':
      return { ...state, config: message.payload.config, stats: message.payload.stats };
    case 'portfolio':
      return { ...state, portfolio: message.payload };
    case 'equity':
      return { ...state, equityCurve: [...state.equityCurve, message.payload].slice(-720) };
    default:
      return state;
  }
}

const TerminalContext = createContext<TerminalState>(EMPTY);

export function TerminalProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reduce, EMPTY);
  const retry = useRef(0);

  useEffect(() => {
    let socket: WebSocket | null = null;
    let timer: number | undefined;
    let disposed = false;

    const connect = () => {
      const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
      socket = new WebSocket(`${protocol}://${window.location.host}/ws`);

      socket.onopen = () => {
        retry.current = 0;
        dispatch({ type: 'connection', connected: true });
      };
      socket.onmessage = (event) => {
        try {
          dispatch({ type: 'message', message: JSON.parse(event.data as string) as ServerMessage });
        } catch {
          /* malformed frame — drop it rather than tearing the socket down */
        }
      };
      socket.onclose = () => {
        dispatch({ type: 'connection', connected: false });
        if (disposed) return;
        // Back off up to 8s so a restarting server is not hammered.
        retry.current = Math.min(retry.current + 1, 8);
        timer = window.setTimeout(connect, retry.current * 1000);
      };
      socket.onerror = () => socket?.close();
    };

    connect();
    return () => {
      disposed = true;
      if (timer) window.clearTimeout(timer);
      socket?.close();
    };
  }, []);

  return <TerminalContext.Provider value={state}>{children}</TerminalContext.Provider>;
}

export function useTerminal(): TerminalState {
  return useContext(TerminalContext);
}

/** Positions for one account, or the whole book when no id is given. */
export function usePositions(accountId?: string): Position[] {
  const { positions } = useTerminal();
  return useMemo(
    () => (accountId ? positions.filter((p) => p.accountId === accountId) : positions),
    [positions, accountId],
  );
}

export function useAccount(accountId?: string): AccountState | undefined {
  const { accounts } = useTerminal();
  return useMemo(
    () => accounts.find((a) => a.id === accountId) ?? accounts.find((a) => a.role === 'master') ?? accounts[0],
    [accounts, accountId],
  );
}
