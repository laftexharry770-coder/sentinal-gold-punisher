import type {
  AccountState,
  BotConfig,
  BotStats,
  ClosedTrade,
  CopySettings,
  Position,
  StateSnapshot,
} from '@sentinal/shared';

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

export interface NewAccountPayload {
  name: string;
  login: string;
  server: string;
  provider: 'sim' | 'metaapi' | 'mt5';
  broker?: string;
  role: 'master' | 'slave' | 'standalone';
  leverage?: number;
  initialBalance?: number;
  metaApiAccountId?: string;
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

export const api = {
  state: () => call<StateSnapshot>('/state'),

  accounts: () => call<AccountState[]>('/accounts'),
  addAccount: (payload: NewAccountPayload) =>
    call<AccountState>('/accounts', { method: 'POST', body: JSON.stringify(payload) }),
  updateAccount: (id: string, patch: { name?: string; role?: string; copy?: Partial<CopySettings> }) =>
    call<AccountState>(`/accounts/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  removeAccount: (id: string) => call<{ ok: boolean }>(`/accounts/${id}`, { method: 'DELETE' }),

  order: (payload: OrderPayload) =>
    call<{ opened: Position[]; errors: string[] }>('/orders', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  closePosition: (id: string) => call<ClosedTrade>(`/positions/${id}/close`, { method: 'POST' }),
  closeAll: (payload: { accountId?: string; side?: 'buy' | 'sell'; profitableOnly?: boolean }) =>
    call<{ closed: number }>('/positions/close-all', { method: 'POST', body: JSON.stringify(payload) }),

  bot: () => call<{ config: BotConfig; stats: BotStats }>('/bot'),
  saveBotConfig: (patch: Partial<BotConfig>) =>
    call<{ config: BotConfig; stats: BotStats }>('/bot/config', {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),
  startBot: () => call<{ config: BotConfig; stats: BotStats }>('/bot/start', { method: 'POST' }),
  stopBot: (closePositions = false) =>
    call<{ config: BotConfig; stats: BotStats }>('/bot/stop', {
      method: 'POST',
      body: JSON.stringify({ closePositions }),
    }),
};
