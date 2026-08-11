import {
  getSymbolSpec,
  roundPrice,
  stopLevels,
  type AccountConfig,
  type ClosedTrade,
  type CloseReason,
  type Position,
} from '@sentinal/shared';
import { config } from '../config.js';
import { round, uid } from '../util.js';
import { TradingAccount, type OpenRequest, type OpenResult } from './account.js';

interface MetaApiPosition {
  id: string;
  symbol: string;
  type: string;
  volume: number;
  openPrice: number;
  currentPrice: number;
  stopLoss?: number;
  takeProfit?: number;
  profit: number;
  swap: number;
  commission?: number;
  comment?: string;
  magic?: number;
  time: string;
}

interface MetaApiAccountInfo {
  balance: number;
  equity: number;
  margin: number;
  freeMargin: number;
  leverage: number;
  currency: string;
  broker: string;
  login: number;
  server: string;
}

/**
 * MetaApi cloud adapter — routes orders to a real MT5 account.
 *
 * Requires METAAPI_TOKEN in the environment and a provisioned MetaApi account
 * id on the account config. Without them the account reports itself as
 * disconnected instead of silently trading a simulation.
 */
export class MetaApiAccount extends TradingAccount {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly remoteId: string;
  private pollTimer: NodeJS.Timeout | null = null;
  /** Remote position id -> local position id. */
  private remoteMap = new Map<string, string>();

  constructor(cfg: AccountConfig) {
    super(cfg);
    this.token = config.metaApiToken;
    this.remoteId = cfg.metaApiAccountId ?? '';
    this.baseUrl = `https://mt-client-api-v1.${config.metaApiRegion}.agiliumtrade.ai/users/current/accounts/${this.remoteId}`;
    this.connected = false;
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    if (!this.token) throw new Error('METAAPI_TOKEN is not set');
    if (!this.remoteId) throw new Error('MetaApi account id is missing');
    const res = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        'auth-token': this.token,
        'content-type': 'application/json',
        ...(init?.headers ?? {}),
      },
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`MetaApi ${res.status}: ${body.slice(0, 200)}`);
    }
    return (await res.json()) as T;
  }

  async connect(): Promise<void> {
    try {
      const info = await this.request<MetaApiAccountInfo>('/account-information');
      this.balance = info.balance;
      this.config = {
        ...this.config,
        leverage: info.leverage ?? this.config.leverage,
        currency: info.currency ?? this.config.currency,
        broker: info.broker ?? this.config.broker,
        server: info.server ?? this.config.server,
        login: String(info.login ?? this.config.login),
      };
      this.connected = true;
      this.connectionError = null;
      await this.syncPositions();
      this.pollTimer = setInterval(() => {
        void this.syncPositions().catch((err) => {
          this.connectionError = err instanceof Error ? err.message : String(err);
        });
      }, 2000);
      this.emit('changed', this);
    } catch (err) {
      this.connected = false;
      this.connectionError = err instanceof Error ? err.message : String(err);
      this.emit('changed', this);
      throw err;
    }
  }

  disconnect(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    this.connected = false;
  }

  /** Pulls the broker's position book and reconciles it with the local view. */
  private async syncPositions(): Promise<void> {
    const remote = await this.request<MetaApiPosition[]>('/positions');
    const seen = new Set<string>();

    for (const rp of remote) {
      seen.add(rp.id);
      const spec = getSymbolSpec(rp.symbol);
      const localId = this.remoteMap.get(rp.id);
      const existing = localId ? this.getPosition(localId) : undefined;

      if (existing) {
        existing.currentPrice = roundPrice(spec, rp.currentPrice);
        existing.profit = round(rp.profit + (rp.swap ?? 0) - (rp.commission ?? 0));
        existing.stopLoss = rp.stopLoss ?? null;
        existing.takeProfit = rp.takeProfit ?? null;
        existing.swap = rp.swap ?? 0;
        continue;
      }

      const position: Position = {
        id: uid('pos'),
        ticket: Number(rp.id) || 0,
        accountId: this.id,
        symbol: rp.symbol,
        side: rp.type === 'POSITION_TYPE_BUY' ? 'buy' : 'sell',
        volume: rp.volume,
        openPrice: rp.openPrice,
        openTime: new Date(rp.time).getTime(),
        stopLoss: rp.stopLoss ?? null,
        takeProfit: rp.takeProfit ?? null,
        stopLossUsd: null,
        takeProfitUsd: null,
        currentPrice: rp.currentPrice,
        profit: round(rp.profit + (rp.swap ?? 0) - (rp.commission ?? 0)),
        swap: rp.swap ?? 0,
        commission: rp.commission ?? 0,
        origin: 'manual',
        basketIndex: 0,
        recoveryLayer: 0,
        comment: rp.comment ?? '',
        magic: rp.magic ?? 0,
        sourceId: null,
      };
      this.remoteMap.set(rp.id, position.id);
      this.adopt(position);
    }

    // Anything the broker no longer reports has been closed away from us.
    for (const [remoteId, localId] of [...this.remoteMap.entries()]) {
      if (seen.has(remoteId)) continue;
      this.remoteMap.delete(remoteId);
      this.close(localId, 'manual');
    }
    this.emit('changed', this);
  }

  protected adopt(position: Position): void {
    this.positions.set(position.id, position);
    this.emit('opened', position, this);
  }

  override open(): OpenResult {
    return { ok: false, error: 'MetaApi accounts require the async submit() path' };
  }

  override async submit(req: OpenRequest): Promise<OpenResult> {
    if (!this.connected) {
      return { ok: false, error: this.connectionError ?? `${this.config.name} is not connected` };
    }
    const spec = getSymbolSpec(req.symbol);
    const reference = this.lastTick
      ? req.side === 'buy'
        ? this.lastTick.ask
        : this.lastTick.bid
      : 0;
    const levels = stopLevels(
      spec,
      req.side,
      req.volume,
      reference,
      req.stopLossUsd ?? null,
      req.takeProfitUsd ?? null,
    );

    try {
      const response = await this.request<{ positionId?: string; message?: string }>('/trade', {
        method: 'POST',
        body: JSON.stringify({
          actionType: req.side === 'buy' ? 'ORDER_TYPE_BUY' : 'ORDER_TYPE_SELL',
          symbol: req.symbol,
          volume: req.volume,
          stopLoss: req.stopLoss ?? levels.stopLoss ?? undefined,
          takeProfit: req.takeProfit ?? levels.takeProfit ?? undefined,
          comment: req.comment?.slice(0, 26),
          magic: req.magic ?? 20260811,
        }),
      });
      await this.syncPositions();
      const localId = response.positionId ? this.remoteMap.get(response.positionId) : undefined;
      const position = localId ? this.getPosition(localId) : undefined;
      if (!position) return { ok: false, error: response.message ?? 'order accepted but no position returned' };
      position.origin = req.origin;
      position.basketIndex = req.basketIndex ?? 0;
      position.recoveryLayer = req.recoveryLayer ?? 0;
      position.sourceId = req.sourceId ?? null;
      return { ok: true, position };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  override async submitClose(id: string, reason: CloseReason): Promise<ClosedTrade | null> {
    const remoteId = [...this.remoteMap.entries()].find(([, local]) => local === id)?.[0];
    if (!remoteId) return this.close(id, reason);
    try {
      await this.request('/trade', {
        method: 'POST',
        body: JSON.stringify({ actionType: 'POSITION_CLOSE_ID', positionId: remoteId }),
      });
    } catch (err) {
      this.connectionError = err instanceof Error ? err.message : String(err);
      return null;
    }
    this.remoteMap.delete(remoteId);
    return this.close(id, reason);
  }
}
