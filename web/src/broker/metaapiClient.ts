import type { Candle, Tick } from '@sentinal/shared';

/**
 * MetaApi cloud client for the browser build.
 *
 * The hosted terminal has no server of its own, so it talks to MetaApi directly
 * with the operator's own token. The token is held in this tab only and is sent
 * nowhere except MetaApi's own API.
 */
export type MetaApiRegion =
  | 'new-york'
  | 'london'
  | 'singapore'
  | 'tokyo'
  | 'sydney'
  | 'mumbai';

export const METAAPI_REGIONS: MetaApiRegion[] = [
  'new-york',
  'london',
  'singapore',
  'tokyo',
  'sydney',
  'mumbai',
];

export interface BrokerCredentials {
  token: string;
  accountId: string;
  region: MetaApiRegion;
  symbol: string;
}

export interface BrokerSymbolSpec {
  symbol: string;
  digits: number;
  tickSize: number;
  contractSize: number;
  minLot: number;
  maxLot: number;
  lotStep: number;
}

export interface BrokerAccountInfo {
  login: string;
  server: string;
  broker: string;
  currency: string;
  balance: number;
  equity: number;
  leverage: number;
}

export class BrokerError extends Error {
  readonly status: number;
  constructor(message: string, status = 0) {
    super(message);
    this.name = 'BrokerError';
    this.status = status;
  }
}

interface RawPrice {
  symbol: string;
  bid: number;
  ask: number;
  time?: string;
  brokerTime?: string;
}

export interface RawPosition {
  id: string;
  symbol: string;
  type: string;
  volume: number;
  openPrice: number;
  currentPrice: number;
  stopLoss?: number;
  takeProfit?: number;
  profit: number;
  swap?: number;
  commission?: number;
  comment?: string;
  magic?: number;
  time: string;
}

interface RawCandle {
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  tickVolume?: number;
}

function clientUrl(region: MetaApiRegion, accountId: string): string {
  return `https://mt-client-api-v1.${region}.agiliumtrade.ai/users/current/accounts/${accountId}`;
}

/** Turns transport and API failures into a message an operator can act on. */
function describe(status: number, body: string): string {
  if (status === 401 || status === 403) return 'Token rejected by MetaApi — check the token and its access rights.';
  if (status === 404) return 'Account not found for this token. Check the MetaApi account id and region.';
  if (status === 429) return 'MetaApi is rate limiting this token. Wait a moment and reconnect.';
  const trimmed = body.trim().slice(0, 160);
  return trimmed ? `MetaApi ${status}: ${trimmed}` : `MetaApi request failed (${status}).`;
}

export class MetaApiClient {
  private readonly base: string;

  constructor(private readonly credentials: BrokerCredentials) {
    this.base = clientUrl(credentials.region, credentials.accountId);
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${this.base}${path}`, {
        ...init,
        headers: {
          'auth-token': this.credentials.token,
          accept: 'application/json',
          ...(init?.body ? { 'content-type': 'application/json' } : {}),
          ...(init?.headers ?? {}),
        },
      });
    } catch (err) {
      // A browser cannot distinguish a CORS refusal from a dead network here.
      throw new BrokerError(
        `Could not reach MetaApi (${err instanceof Error ? err.message : 'network error'}). ` +
          'Check your connection, or run the server build if your network blocks the request.',
      );
    }
    if (!response.ok) {
      throw new BrokerError(describe(response.status, await response.text().catch(() => '')), response.status);
    }
    return (await response.json()) as T;
  }

  /** Validates the credentials and returns what the broker reports. */
  async accountInfo(): Promise<BrokerAccountInfo> {
    const info = await this.request<{
      login?: number | string;
      server?: string;
      broker?: string;
      currency?: string;
      balance?: number;
      equity?: number;
      leverage?: number;
    }>('/account-information');

    return {
      login: String(info.login ?? ''),
      server: info.server ?? 'unknown',
      broker: info.broker ?? 'MetaApi',
      currency: info.currency ?? 'USD',
      balance: Number(info.balance ?? 0),
      equity: Number(info.equity ?? info.balance ?? 0),
      leverage: Number(info.leverage ?? 100),
    };
  }

  /** Every symbol this account can trade, as the broker names them. */
  async symbols(): Promise<string[]> {
    const list = await this.request<string[]>('/symbols');
    return Array.isArray(list) ? list : [];
  }

  /**
   * The broker's own contract specification. Gold is 100 oz per lot at most
   * brokers but not all, and the lot grid and digits vary, so the engine uses
   * these numbers rather than assuming.
   */
  async specification(symbol = this.credentials.symbol): Promise<BrokerSymbolSpec> {
    const raw = await this.request<{
      symbol?: string;
      digits?: number;
      tickSize?: number;
      contractSize?: number;
      minVolume?: number;
      maxVolume?: number;
      volumeStep?: number;
    }>(`/symbols/${encodeURIComponent(symbol)}/specification`);

    const digits = Number(raw.digits ?? 2);
    return {
      symbol: raw.symbol ?? symbol,
      digits,
      tickSize: Number(raw.tickSize) > 0 ? Number(raw.tickSize) : 10 ** -digits,
      contractSize: Number(raw.contractSize) > 0 ? Number(raw.contractSize) : 100,
      minLot: Number(raw.minVolume) > 0 ? Number(raw.minVolume) : 0.01,
      maxLot: Number(raw.maxVolume) > 0 ? Number(raw.maxVolume) : 100,
      lotStep: Number(raw.volumeStep) > 0 ? Number(raw.volumeStep) : 0.01,
    };
  }

  async currentPrice(): Promise<Tick> {
    const symbol = encodeURIComponent(this.credentials.symbol);
    const price = await this.request<RawPrice>(`/symbols/${symbol}/current-price?keepSubscription=true`);
    const time = price.time ? new Date(price.time).getTime() : Date.now();
    return {
      symbol: this.credentials.symbol,
      bid: Number(price.bid),
      ask: Number(price.ask),
      time: Number.isFinite(time) ? time : Date.now(),
    };
  }

  /* ---------------------------------------------------------------- */
  /* Trading — these place and close real orders on the account         */
  /* ---------------------------------------------------------------- */

  private trade<T>(body: Record<string, unknown>): Promise<T> {
    return this.request<T>('/trade', { method: 'POST', body: JSON.stringify(body) });
  }

  async openPositions(): Promise<RawPosition[]> {
    const list = await this.request<RawPosition[]>('/positions');
    return Array.isArray(list) ? list : [];
  }

  /** Sends a market order. Resolves with the broker's position id. */
  async marketOrder(input: {
    side: 'buy' | 'sell';
    volume: number;
    stopLoss?: number | null;
    takeProfit?: number | null;
    comment?: string;
    magic?: number;
  }): Promise<{ positionId?: string; orderId?: string; message?: string; stringCode?: string }> {
    return this.trade({
      actionType: input.side === 'buy' ? 'ORDER_TYPE_BUY' : 'ORDER_TYPE_SELL',
      symbol: this.credentials.symbol,
      volume: input.volume,
      stopLoss: input.stopLoss ?? undefined,
      takeProfit: input.takeProfit ?? undefined,
      // MetaTrader truncates comments; keep within what it accepts.
      comment: input.comment?.slice(0, 26),
      magic: input.magic ?? 20260811,
    });
  }

  async closePositionById(positionId: string): Promise<{ stringCode?: string; message?: string }> {
    return this.trade({ actionType: 'POSITION_CLOSE_ID', positionId });
  }

  async modifyPosition(positionId: string, stopLoss: number | null, takeProfit: number | null): Promise<unknown> {
    return this.trade({
      actionType: 'POSITION_MODIFY',
      positionId,
      stopLoss: stopLoss ?? undefined,
      takeProfit: takeProfit ?? undefined,
    });
  }

  /** Recent M1 bars, oldest first, for the chart and the indicators. */
  async history(limit = 200): Promise<Candle[]> {
    const symbol = encodeURIComponent(this.credentials.symbol);
    const bars = await this.request<RawCandle[]>(
      `/historical-market-data/symbols/${symbol}/timeframes/1m/candles?limit=${limit}`,
    );
    return bars
      .map((bar) => ({
        time: new Date(bar.time).getTime(),
        open: Number(bar.open),
        high: Number(bar.high),
        low: Number(bar.low),
        close: Number(bar.close),
        volume: Number(bar.tickVolume ?? 0),
      }))
      .filter((bar) => Number.isFinite(bar.time) && Number.isFinite(bar.close))
      .sort((a, b) => a.time - b.time);
  }
}

/** Symbols that are plausibly gold, for when the configured name is unknown. */
export function goldCandidates(symbols: string[]): string[] {
  return symbols.filter((symbol) => /^(xau|gold)/i.test(symbol)).slice(0, 12);
}

const STORAGE_KEY = 'sentinal.broker.credentials';

/** Credentials are only persisted when the operator asks for it. */
export function saveCredentials(credentials: BrokerCredentials): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(credentials));
  } catch {
    /* private browsing or a full quota — connecting still works for this session */
  }
}

export function loadCredentials(): BrokerCredentials | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<BrokerCredentials>;
    if (!parsed.token || !parsed.accountId) return null;
    return {
      token: parsed.token,
      accountId: parsed.accountId,
      region: (parsed.region ?? 'new-york') as MetaApiRegion,
      symbol: parsed.symbol ?? 'XAUUSD',
    };
  } catch {
    return null;
  }
}

export function clearCredentials(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* nothing to clear */
  }
}
