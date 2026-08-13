import { TradingAccount, round, uid, type OpenRequest, type OpenResult } from '@sentinal/engine';
import {
  getSymbolSpec,
  roundPrice,
  type AccountConfig,
  type ClosedTrade,
  type CloseReason,
  type Position,
  type Tick,
} from '@sentinal/shared';
import {
  CONTRACT_SIZE,
  stakeFor,
  volumeFor,
  type DerivClient,
  type DerivContract,
} from './derivClient';

/**
 * An account whose orders are real Deriv multiplier contracts.
 *
 * Every entry and exit goes to Deriv and the local book is rebuilt from what
 * Deriv reports, so the terminal shows Deriv's contracts and Deriv's money
 * rather than a local guess. A rejected order stays rejected — nothing is
 * filled locally as a consolation.
 *
 * Two behaviours differ deliberately from the simulated account:
 *
 * - **Stops are not checked here.** Deriv holds the stop loss and take profit
 *   on the contract itself and closes it; checking again locally would close a
 *   position the broker still has open.
 * - **Margin is the stake.** A multiplier contract commits its stake and can
 *   lose no more, so free margin is reported against stakes rather than against
 *   a leverage calculation that does not apply.
 */
export class DerivBrowserAccount extends TradingAccount {
  /** Deriv contract id -> local position id. */
  private readonly contractMap = new Map<string, string>();
  /** Local position id -> stake committed, for margin. */
  private readonly stakes = new Map<string, number>();
  /** Contracts sold away from us, so a late stream update cannot resurrect them. */
  private readonly settled = new Set<string>();

  constructor(
    config: AccountConfig,
    private readonly client: DerivClient,
    private readonly multiplier: number,
    private readonly minStake: number,
    private readonly onError: (message: string) => void,
  ) {
    super(config);
  }

  override async connect(): Promise<void> {
    await this.client.subscribeOpenContracts((contract) => this.apply(contract));
    this.connected = true;
  }

  override disconnect(): void {
    this.connected = false;
  }

  /* ------------------------------------------------------------------ */
  /* Book                                                                */
  /* ------------------------------------------------------------------ */

  /** Folds one contract update into the local book. */
  private apply(contract: DerivContract): void {
    if (this.settled.has(contract.contractId)) return;

    const localId = this.contractMap.get(contract.contractId);
    const existing = localId ? this.getPosition(localId) : undefined;

    if (contract.isSold) {
      this.settled.add(contract.contractId);
      this.contractMap.delete(contract.contractId);
      // The exit spot reproduces Deriv's own profit exactly, because the lot
      // size was derived from the stake at the entry spot.
      if (localId) this.close(localId, 'manual', contract.currentSpot || undefined);
      this.emit('changed', this);
      return;
    }

    if (existing) {
      this.merge(existing, contract);
      this.emit('changed', this);
      return;
    }

    // Anything already running when we connected is somebody else's trade, but
    // it is still the account's exposure, so it belongs on the book.
    const adopted = this.toPosition(contract, 'manual');
    this.contractMap.set(contract.contractId, adopted.id);
    this.stakes.set(adopted.id, contract.buyPrice);
    this.positions.set(adopted.id, adopted);
    this.emit('opened', adopted, this);
    this.emit('changed', this);
  }

  private merge(position: Position, contract: DerivContract): void {
    const spec = getSymbolSpec(position.symbol);
    if (contract.entrySpot > 0) {
      position.openPrice = roundPrice(spec, contract.entrySpot);
      position.volume = volumeFor(contract.buyPrice, contract.entrySpot, contract.multiplier);
    }
    if (contract.currentSpot > 0) position.currentPrice = roundPrice(spec, contract.currentSpot);
    position.profit = round(contract.profit);
    position.commission = round(contract.commission);
    position.stopLoss = contract.stopLossBarrier;
    position.takeProfit = contract.takeProfitBarrier;
    position.stopLossUsd = contract.stopLossAmount;
    position.takeProfitUsd = contract.takeProfitAmount;
    this.stakes.set(position.id, contract.buyPrice);
  }

  private toPosition(contract: DerivContract, origin: Position['origin']): Position {
    const symbol = this.lastTick?.symbol ?? contract.symbol;
    const spec = getSymbolSpec(symbol);
    const entry = contract.entrySpot > 0 ? contract.entrySpot : contract.currentSpot;

    return {
      id: uid('pos'),
      ticket: Number(contract.contractId) || 0,
      accountId: this.id,
      symbol,
      side: contract.contractType === 'MULTDOWN' ? 'sell' : 'buy',
      volume: volumeFor(contract.buyPrice, entry, contract.multiplier),
      openPrice: roundPrice(spec, entry),
      openTime: contract.purchaseTime,
      stopLoss: contract.stopLossBarrier,
      takeProfit: contract.takeProfitBarrier,
      stopLossUsd: contract.stopLossAmount,
      takeProfitUsd: contract.takeProfitAmount,
      currentPrice: roundPrice(spec, contract.currentSpot || entry),
      profit: round(contract.profit),
      swap: 0,
      commission: round(contract.commission),
      origin,
      basketIndex: 0,
      recoveryLayer: 0,
      comment: '',
      magic: 0,
      sourceId: null,
    };
  }

  /* ------------------------------------------------------------------ */
  /* Order entry                                                         */
  /* ------------------------------------------------------------------ */

  /** Local fills are never correct for a live account. */
  override open(): OpenResult {
    return { ok: false, error: 'live Deriv accounts place orders through submit()' };
  }

  override async submit(req: OpenRequest): Promise<OpenResult> {
    if (!this.connected) {
      return { ok: false, error: this.connectionError ?? `${this.config.name} is not connected` };
    }
    const tick = this.lastTick;
    if (!tick) return { ok: false, error: 'no quote available yet' };

    const price = req.side === 'buy' ? tick.ask : tick.bid;
    const stake = stakeFor(req.volume, price, this.multiplier);
    if (stake < this.minStake) {
      return {
        ok: false,
        error:
          `${req.volume} lots is a ${stake.toFixed(2)} stake at multiplier ${this.multiplier}, ` +
          `below Deriv's ${this.minStake} minimum. Raise the lot size or lower the multiplier.`,
      };
    }
    if (stake > this.freeMargin()) {
      return { ok: false, error: `insufficient balance (needs a ${stake.toFixed(2)} stake)` };
    }

    try {
      const result = await this.client.buy({
        side: req.side,
        stake,
        stopLoss: req.stopLossUsd ?? null,
        takeProfit: req.takeProfitUsd ?? null,
      });

      // The contract is live now; the stream will correct the entry spot and
      // the running profit a moment later. Building it here rather than waiting
      // keeps the engine's basket bookkeeping in step with what it just sent.
      const spec = getSymbolSpec(req.symbol);
      const position: Position = {
        id: uid('pos'),
        ticket: Number(result.contractId) || 0,
        accountId: this.id,
        symbol: req.symbol,
        side: req.side,
        volume: volumeFor(result.buyPrice, price, this.multiplier),
        openPrice: roundPrice(spec, price),
        openTime: tick.time,
        stopLoss: null,
        takeProfit: null,
        stopLossUsd: req.stopLossUsd ?? null,
        takeProfitUsd: req.takeProfitUsd ?? null,
        currentPrice: roundPrice(spec, price),
        profit: 0,
        swap: 0,
        commission: 0,
        origin: req.origin,
        basketIndex: req.basketIndex ?? 0,
        recoveryLayer: req.recoveryLayer ?? 0,
        comment: req.comment ?? '',
        magic: req.magic ?? 0,
        sourceId: req.sourceId ?? null,
      };

      this.contractMap.set(result.contractId, position.id);
      this.stakes.set(position.id, result.buyPrice);
      // Deriv debits the stake at purchase. Booking it here rather than waiting
      // for the balance stream stops a burst of legs from over-committing the
      // account in the moment before that stream catches up.
      this.balance = round(this.balance - result.buyPrice);
      this.positions.set(position.id, position);
      this.emit('opened', position, this);
      this.emit('changed', this);
      return { ok: true, position };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.onError(`Order rejected: ${message}`);
      return { ok: false, error: message };
    }
  }

  override async submitClose(id: string, reason: CloseReason): Promise<ClosedTrade | null> {
    const contractId = [...this.contractMap.entries()].find(([, local]) => local === id)?.[0];
    if (!contractId) return this.close(id, reason);

    try {
      await this.client.sell(contractId);
    } catch (err) {
      this.onError(`Close rejected: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }

    this.settled.add(contractId);
    this.contractMap.delete(contractId);
    return this.close(id, reason);
  }

  /**
   * Settling a contract returns its stake as well as its profit.
   *
   * The base class books only the profit, because a margin account never had
   * the stake taken out of its balance in the first place. Deriv did, so the
   * stake is credited back here and the balance stream then confirms it rather
   * than having to correct it.
   */
  override close(id: string, reason: CloseReason, priceOverride?: number): ClosedTrade | null {
    const stake = this.stakes.get(id) ?? 0;
    const trade = super.close(id, reason, priceOverride);
    if (!trade) return null;
    this.stakes.delete(id);
    this.balance = round(this.balance + stake);
    return trade;
  }

  /* ------------------------------------------------------------------ */
  /* Valuation — Deriv's figures, not ours                               */
  /* ------------------------------------------------------------------ */

  /**
   * Quotes still arrive so the engine can time entries, but nothing is
   * revalued or stopped out here: the contract stream is the only source of
   * truth for what a live contract is worth.
   */
  override onTick(tick: Tick): void {
    this.lastTick = tick;
  }

  /** A multiplier contract commits its stake and can lose no more. */
  override usedMargin(): number {
    let total = 0;
    for (const stake of this.stakes.values()) total += stake;
    return round(total);
  }

  /**
   * Deriv takes the stake out of the balance the moment a contract is bought,
   * so the balance it reports is cash only. Equity has to add the contracts
   * back — each is worth its stake plus its running profit — or the terminal
   * would show the account shrinking every time it opened a trade.
   */
  override equity(): number {
    return round(this.balance + this.usedMargin() + this.floatingProfit());
  }

  /** Only that cash can back the next contract; open stakes are already spent. */
  override freeMargin(): number {
    return round(this.balance);
  }

  /** Exposure in lots, for the copier's sizing and the account panel. */
  notionalLots(): number {
    let total = 0;
    for (const position of this.listPositions()) total += position.volume * CONTRACT_SIZE;
    return round(total / CONTRACT_SIZE);
  }
}
