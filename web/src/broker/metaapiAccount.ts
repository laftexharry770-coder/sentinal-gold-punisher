import { TradingAccount, round, uid, type OpenRequest, type OpenResult } from '@sentinal/engine';
import {
  getSymbolSpec,
  roundPrice,
  stopLevels,
  type AccountConfig,
  type ClosedTrade,
  type CloseReason,
  type Position,
} from '@sentinal/shared';
import type { MetaApiClient, RawPosition } from './metaapiClient';

/**
 * An account whose orders go to the real broker.
 *
 * Every entry and exit is sent to MetaApi and the local book is reconciled from
 * what the broker reports, so the terminal shows the broker's positions rather
 * than a local guess. A rejected order stays rejected — nothing is filled
 * locally as a consolation.
 */
export class MetaApiBrowserAccount extends TradingAccount {
  /** Broker position id -> local position id. */
  private readonly remoteMap = new Map<string, string>();
  private syncTimer: ReturnType<typeof setInterval> | null = null;
  private syncing = false;

  constructor(
    config: AccountConfig,
    private readonly client: MetaApiClient,
    private readonly onError: (message: string) => void,
  ) {
    super(config);
  }

  override async connect(): Promise<void> {
    this.connected = true;
    await this.sync();
    this.syncTimer = setInterval(() => void this.sync(), 2000);
  }

  override disconnect(): void {
    if (this.syncTimer) clearInterval(this.syncTimer);
    this.syncTimer = null;
    this.connected = false;
  }

  /** Mirrors the broker's open positions into the local book. */
  private async sync(): Promise<void> {
    if (this.syncing) return;
    this.syncing = true;
    try {
      const remote = await this.client.openPositions();
      const seen = new Set<string>();

      for (const rp of remote) {
        seen.add(rp.id);
        const localId = this.remoteMap.get(rp.id);
        const existing = localId ? this.getPosition(localId) : undefined;
        if (existing) {
          this.applyRemote(existing, rp);
          continue;
        }
        const adopted = this.toPosition(rp);
        this.remoteMap.set(rp.id, adopted.id);
        this.positions.set(adopted.id, adopted);
        this.emit('opened', adopted, this);
      }

      // Anything the broker no longer lists was closed, here or elsewhere.
      for (const [remoteId, localId] of [...this.remoteMap.entries()]) {
        if (seen.has(remoteId)) continue;
        this.remoteMap.delete(remoteId);
        this.close(localId, 'manual');
      }
      this.emit('changed', this);
    } catch (err) {
      this.connectionError = err instanceof Error ? err.message : String(err);
    } finally {
      this.syncing = false;
    }
  }

  private applyRemote(position: Position, rp: RawPosition): void {
    const spec = getSymbolSpec(position.symbol);
    position.currentPrice = roundPrice(spec, rp.currentPrice);
    position.profit = round(rp.profit + (rp.swap ?? 0) - (rp.commission ?? 0));
    position.stopLoss = rp.stopLoss ?? null;
    position.takeProfit = rp.takeProfit ?? null;
    position.swap = rp.swap ?? 0;
    position.commission = rp.commission ?? 0;
  }

  private toPosition(rp: RawPosition): Position {
    return {
      id: uid('pos'),
      ticket: Number(rp.id) || 0,
      accountId: this.id,
      symbol: rp.symbol,
      side: rp.type === 'POSITION_TYPE_BUY' ? 'buy' : 'sell',
      volume: rp.volume,
      openPrice: rp.openPrice,
      openTime: new Date(rp.time).getTime() || Date.now(),
      stopLoss: rp.stopLoss ?? null,
      takeProfit: rp.takeProfit ?? null,
      stopLossUsd: null,
      takeProfitUsd: null,
      currentPrice: rp.currentPrice,
      profit: round(rp.profit + (rp.swap ?? 0) - (rp.commission ?? 0)),
      swap: rp.swap ?? 0,
      commission: rp.commission ?? 0,
      // Anything already on the account when we connected is somebody else's.
      origin: 'manual',
      basketIndex: 0,
      recoveryLayer: 0,
      comment: rp.comment ?? '',
      magic: rp.magic ?? 0,
      sourceId: null,
    };
  }

  /** Local fills are never correct for a live account. */
  override open(): OpenResult {
    return { ok: false, error: 'live accounts place orders through submit()' };
  }

  override async submit(req: OpenRequest): Promise<OpenResult> {
    if (!this.connected) {
      return { ok: false, error: this.connectionError ?? `${this.config.name} is not connected` };
    }
    const tick = this.lastTick;
    if (!tick) return { ok: false, error: 'no quote available yet' };

    const spec = getSymbolSpec(req.symbol);
    const reference = req.side === 'buy' ? tick.ask : tick.bid;
    const levels = stopLevels(
      spec,
      req.side,
      req.volume,
      reference,
      req.stopLossUsd ?? null,
      req.takeProfitUsd ?? null,
    );

    try {
      const result = await this.client.marketOrder({
        side: req.side,
        volume: req.volume,
        stopLoss: req.stopLoss !== undefined ? req.stopLoss : levels.stopLoss,
        takeProfit: req.takeProfit !== undefined ? req.takeProfit : levels.takeProfit,
        comment: req.comment,
        magic: req.magic,
      });

      if (!result.positionId) {
        return { ok: false, error: result.message ?? result.stringCode ?? 'broker did not return a position' };
      }

      await this.sync();
      const localId = this.remoteMap.get(result.positionId);
      const position = localId ? this.getPosition(localId) : undefined;
      if (!position) return { ok: false, error: 'order accepted but the position has not appeared yet' };

      // Tag it with what the engine intended, now that it is really on the book.
      position.origin = req.origin;
      position.basketIndex = req.basketIndex ?? 0;
      position.recoveryLayer = req.recoveryLayer ?? 0;
      position.sourceId = req.sourceId ?? null;
      position.stopLossUsd = req.stopLossUsd ?? null;
      position.takeProfitUsd = req.takeProfitUsd ?? null;
      return { ok: true, position };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.onError(`Order rejected: ${message}`);
      return { ok: false, error: message };
    }
  }

  override async submitClose(id: string, reason: CloseReason): Promise<ClosedTrade | null> {
    const remoteId = [...this.remoteMap.entries()].find(([, local]) => local === id)?.[0];
    if (!remoteId) return this.close(id, reason);
    try {
      await this.client.closePositionById(remoteId);
    } catch (err) {
      this.onError(`Close rejected: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
    this.remoteMap.delete(remoteId);
    return this.close(id, reason);
  }
}
