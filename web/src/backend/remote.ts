import type { AccountState, AiReview, BotConfig, ClosedTrade, CopySettings, Position, ServerMessage } from '@sentinal/shared';
import type { BrokerIdentity, SessionState } from './session';
import type {
  BotView,
  MetaApiAccountSummary,
  NewAccountPayload,
  OrderPayload,
  AddedExpert,
  Subscription,
  TerminalBackend,
} from './types';

const BASE = '/api';
const KEY_STORAGE = 'sentinal.serverKey';

/**
 * The server's access key: taken once from a ?key= link, then remembered in
 * this browser and dropped from the address bar so it is not shared by accident.
 */
function accessKey(): string {
  try {
    const url = new URL(window.location.href);
    const fromLink = url.searchParams.get('key');
    if (fromLink) {
      localStorage.setItem(KEY_STORAGE, fromLink);
      url.searchParams.delete('key');
      window.history.replaceState(window.history.state, '', url);
      return fromLink;
    }
    return localStorage.getItem(KEY_STORAGE) ?? '';
  } catch {
    return '';
  }
}

function askForKey(): void {
  const key = window.prompt('This Sentinal server needs its access key (ACCESS_KEY):');
  if (!key) return;
  try {
    localStorage.setItem(KEY_STORAGE, key.trim());
  } catch {
    /* without storage the key lasts for this page only */
  }
  window.location.reload();
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', 'x-sentinal-key': accessKey() },
  });
  if (res.status === 401) askForKey();
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

const post = <T>(path: string, body?: unknown) =>
  call<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) });

/**
 * Talks to the Node execution server over REST plus a WebSocket stream.
 *
 * The server holds the MetaApi token and the accounts, and keeps trading
 * when every browser is closed — which is where a copier belongs. This build
 * is never gated behind a sign-in screen.
 */
export function createRemoteBackend(): TerminalBackend {
  /** Whether the server has ANTHROPIC_API_KEY, as its AI status reports. */
  let claudeConfigured = false;
  let session: SessionState = {
    status: 'live',
    broker: { login: '', server: 'execution server', broker: 'Sentinal', currency: 'USD', accountType: 'sim', platform: 'sim', metaApiId: null },
    execution: 'broker',
  };
  const listeners = new Set<(state: SessionState) => void>();

  const refreshSession = () =>
    call<{ broker: BrokerIdentity; execution: 'broker' | 'local' }>('/session')
      .then((s) => {
        session = { status: 'live', broker: s.broker, execution: s.execution };
        for (const listener of listeners) listener(session);
      })
      .catch(() => undefined);

  return {
    sessionState: () => session,
    onSession(listener) {
      listeners.add(listener);
      listener(session);
      void refreshSession();
      return () => {
        listeners.delete(listener);
      };
    },
    listMetaApiAccounts: () => call<MetaApiAccountSummary[]>('/metaapi/accounts'),
    provisionMetaApiAccount: (_token, input) => post<MetaApiAccountSummary>('/metaapi/accounts', input),
    connectBroker: async () => {
      throw new Error('The execution server connects with METAAPI_TOKEN from its environment.');
    },
    startDemo: async () => {},
    signOut: async () => {},
    savedCredentials: () => null,

    subscribe({ onMessage, onStatus }: Subscription) {
      let socket: WebSocket | null = null;
      let timer: number | undefined;
      let disposed = false;
      let retry = 0;

      const connect = () => {
        const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
        const key = accessKey();
        socket = new WebSocket(`${protocol}://${window.location.host}/ws${key ? `?key=${encodeURIComponent(key)}` : ''}`);

        socket.onopen = () => {
          retry = 0;
          onStatus(true);
        };
        socket.onmessage = (event) => {
          try {
            const message = JSON.parse(event.data as string) as ServerMessage;
            if (message.type === 'ai') claudeConfigured = message.payload.claude.configured;
            if (message.type === 'snapshot') claudeConfigured = message.payload.ai?.claude.configured ?? false;
            onMessage(message);
          } catch {
            /* malformed frame — drop it rather than tearing the socket down */
          }
        };
        socket.onclose = (event) => {
          onStatus(false);
          if (disposed) return;
          if (event.code === 4401) {
            askForKey();
            return;
          }
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

    addAccount: (payload: NewAccountPayload) => post<AccountState>('/accounts', payload),
    addMetaApiFollower: (metaApiId: string, copy: Partial<CopySettings>) =>
      post<AccountState>('/metaapi/followers', { metaApiId, copy }),
    updateAccount: (id, patch: { name?: string; role?: string; copy?: Partial<CopySettings> }) =>
      call<AccountState>(`/accounts/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
    removeAccount: (id) => call<{ ok: boolean }>(`/accounts/${id}`, { method: 'DELETE' }),
    streamEveryTick: async (id) => {
      await post(`/accounts/${id}/stream-every-tick`);
    },

    order: (payload: OrderPayload) => post<{ opened: Position[]; errors: string[] }>('/orders', payload),
    closePosition: (id) => post<ClosedTrade>(`/positions/${id}/close`),
    closeAll: (payload) => post<{ closed: number }>('/positions/close-all', payload),

    saveBotConfig: (patch: Partial<BotConfig>) =>
      call<BotView>('/bot/config', { method: 'PATCH', body: JSON.stringify(patch) }),
    startBot: () => post<BotView>('/bot/start'),
    stopBot: (closePositions = false) => post<BotView>('/bot/stop', { closePositions }),
    useBuiltinStrategy: (strategy) => post<BotView>('/strategy/builtin', { strategy }),
    addExperts: (files, options = {}) => post<AddedExpert[]>('/experts', { files, ...options }),
    setExpertEnabled: async (id, enabled) => {
      await call(`/experts/${id}`, { method: 'PATCH', body: JSON.stringify({ enabled }) });
    },
    configureExpert: async (id, patch) => {
      await call(`/experts/${id}`, { method: 'PATCH', body: JSON.stringify(patch) });
    },
    removeExpert: async (id) => {
      await call(`/experts/${id}`, { method: 'DELETE' });
    },

    reviewAi: () => post<AiReview>('/ai/review'),
    approveAiSuggestion: async () => {
      await post('/ai/pending/approve');
    },
    dismissAiSuggestion: async () => {
      await post('/ai/pending/dismiss');
    },
    resumeAi: async () => {
      await post('/ai/resume');
    },
    // The server keeps its own key, set as ANTHROPIC_API_KEY in its environment.
    claudeKey: () => ({ where: 'server', configured: claudeConfigured }),
    setClaudeKey: async () => {
      throw new Error('This terminal runs on the execution server: set ANTHROPIC_API_KEY in its environment.');
    },
  };
}
