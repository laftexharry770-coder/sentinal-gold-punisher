import type { AccountState, BotConfig, ClosedTrade, CopySettings, Position, ServerMessage } from '@sentinal/shared';
import type { SessionState } from './session';
import type {
  BotView,
  NewAccountPayload,
  OrderPayload,
  Subscription,
  TerminalBackend,
} from './types';

const BASE = '/api';

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'content-type': 'application/json' },
    ...init,
  });
  const text = await res.text();
  const body = text ? (JSON.parse(text) as unknown) : null;
  if (!res.ok) {
    const message =
      body && typeof body === 'object' && 'error' in body
        ? String((body as { error: unknown }).error)
        : `request failed (${res.status})`;
    throw new Error(message);
  }
  return body as T;
}

/** Talks to the Node execution server over REST plus a WebSocket stream. */
export function createRemoteBackend(): TerminalBackend {
  // The execution server owns the broker session and its accounts, so this
  // build is never gated behind a sign-in screen.
  const serverSession: SessionState = {
    status: 'live',
    broker: { login: '', server: 'execution server', broker: 'Sentinal', currency: 'USD' },
    execution: 'broker',
  };

  return {
    sessionState: () => serverSession,
    onSession(listener) {
      listener(serverSession);
      return () => {};
    },
    connectBroker: async () => {
      throw new Error('Link accounts from the Connect Broker screen on the server build.');
    },
    startDemo: async () => {},
    signOut: async () => {},
    savedCredentials: () => null,
    // The execution server holds no Deriv session of its own.
    mt5Accounts: async () => [],

    subscribe({ onMessage, onStatus }: Subscription) {
      let socket: WebSocket | null = null;
      let timer: number | undefined;
      let disposed = false;
      let retry = 0;

      const connect = () => {
        const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
        socket = new WebSocket(`${protocol}://${window.location.host}/ws`);

        socket.onopen = () => {
          retry = 0;
          onStatus(true);
        };
        socket.onmessage = (event) => {
          try {
            onMessage(JSON.parse(event.data as string) as ServerMessage);
          } catch {
            /* malformed frame — drop it rather than tearing the socket down */
          }
        };
        socket.onclose = () => {
          onStatus(false);
          if (disposed) return;
          // Back off up to 8s so a restarting server is not hammered.
          retry = Math.min(retry + 1, 8);
          timer = window.setTimeout(connect, retry * 1000);
        };
        socket.onerror = () => socket?.close();
      };

      connect();
      return () => {
        disposed = true;
        if (timer) window.clearTimeout(timer);
        socket?.close();
      };
    },

    addAccount: (payload: NewAccountPayload) =>
      call<AccountState>('/accounts', { method: 'POST', body: JSON.stringify(payload) }),
    updateAccount: (id, patch: { name?: string; role?: string; copy?: Partial<CopySettings> }) =>
      call<AccountState>(`/accounts/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
    removeAccount: (id) => call<{ ok: boolean }>(`/accounts/${id}`, { method: 'DELETE' }),

    order: (payload: OrderPayload) =>
      call<{ opened: Position[]; errors: string[] }>('/orders', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    closePosition: (id) => call<ClosedTrade>(`/positions/${id}/close`, { method: 'POST' }),
    closeAll: (payload) =>
      call<{ closed: number }>('/positions/close-all', { method: 'POST', body: JSON.stringify(payload) }),

    saveBotConfig: (patch: Partial<BotConfig>) =>
      call<BotView>('/bot/config', { method: 'PATCH', body: JSON.stringify(patch) }),
    startBot: () => call<BotView>('/bot/start', { method: 'POST' }),
    stopBot: (closePositions = false) =>
      call<BotView>('/bot/stop', { method: 'POST', body: JSON.stringify({ closePositions }) }),
  };
}
