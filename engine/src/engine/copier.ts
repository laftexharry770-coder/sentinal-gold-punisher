import { Emitter } from '../emitter.js';
import {
  DEFAULT_BOT_CONFIG,
  burstSize,
  roundLot,
  roundPrice,
  stopLevels,
  type ClosedTrade,
  type CloseReason,
  type CopySettings,
  type DispatchConfig,
  type DispatchReport,
  type Position,
  type Side,
} from '@sentinal/shared';
import type { ActionResult, OpenRequest, OpenResult, TradingAccount } from '../broker/account.js';
import type { AccountManager } from '../broker/manager.js';
import type { Journal } from '../journal.js';
import { uid } from '../util.js';

/**
 * Master → follower replication, built to keep the gap between accounts as
 * small as the network allows.
 *
 * In 'simultaneous' mode an order is sent to the master and to every follower
 * in the same instant — followers do not wait to hear that the master filled,
 * which would add a full broker round trip to every copy. The report for each
 * dispatch records how long the sends took to leave (microseconds, all in one
 * tick of the event loop) and how long each broker took to acknowledge.
 *
 * Positions the engine did not open — a manual trade in MetaTrader, or an EA
 * running there in mirror mode — are copied the moment the master's stream
 * reports them, to every follower in parallel. Closes, partial closes and stop
 * changes follow the same fan-out.
 */

interface Link {
  accountId: string;
  positionId: string;
}

/** Performance clock where available, so sub-millisecond gaps are visible. */
function now(): number {
  const perf = (globalThis as { performance?: { now(): number } }).performance;
  return perf ? perf.now() : Date.now();
}

/** Short, unique and within MetaApi's 26-character comment + clientId budget. */
function newClientId(): string {
  return `S${Date.now().toString(36).slice(-5)}${Math.floor(Math.random() * 46656).toString(36).padStart(3, '0')}`;
}

/**
 * The instrument a broker symbol stands for. Brokers decorate gold
 * differently — XAUUSD, XAUUSDm, XAUUSD.raw, GOLD, GOLD# — and a copy has to
 * land on the follower's own name for it.
 */
export function baseSymbol(symbol: string): string {
  const letters = symbol.toUpperCase().replace(/[^A-Z]/g, '');
  if (letters.includes('XAUUSD') || letters.startsWith('GOLD')) return 'XAUUSD';
  if (letters.includes('XAGUSD') || letters.startsWith('SILVER')) return 'XAGUSD';
  return letters.slice(0, 6) || symbol;
}

export class CopyTradeEngine extends Emitter {
  /** master position id -> follower positions */
  private readonly links = new Map<string, Link[]>();
  /** Client ids the dispatcher sent itself, so the fill events are not copied twice. */
  private readonly dispatched = new Set<string>();
  /** Master positions whose close the dispatcher is already propagating. */
  private readonly closing = new Set<string>();
  private readonly modifying = new Set<string>();
  private readonly reports: DispatchReport[] = [];

  config: DispatchConfig = { ...DEFAULT_BOT_CONFIG.dispatch };
  /** Copy positions the engine did not open itself (manual trades, an EA running in MT5). */
  mirrorExternal = false;

  constructor(
    private readonly accounts: AccountManager,
    private readonly journal: Journal,
  ) {
    super();
    this.accounts.on('opened', (position: Position, account: TradingAccount) => {
      void this.onMasterOpen(position, account);
    });
    this.accounts.on('closed', (trade: ClosedTrade, position: Position, account: TradingAccount) => {
      void this.onMasterClose(trade, position, account);
    });
    this.accounts.on('partial', (trade: ClosedTrade, position: Position) => {
      void this.onMasterPartial(trade, position);
    });
    this.accounts.on('modified', (position: Position) => {
      void this.onMasterModify(position);
    });
    // A broker account (re)synchronised: copies it holds can be matched again.
    this.accounts.on('synced', () => this.relink());
  }

  /** The client id a follower's copy of a master position carries. */
  static copyClientId(masterTicket: number): string | null {
    return masterTicket > 0 ? `M${masterTicket.toString(36)}` : null;
  }

  /**
   * Rebuilds master → copy links from the client ids on the broker's books,
   * so closes and stop changes keep reaching the copies after the terminal
   * restarts. A copy whose master position is gone is reported, not closed:
   * whether to close it is the operator's call.
   */
  relink(): void {
    for (const master of this.accounts.list().filter((a) => a.config.role === 'master')) {
      const followers = this.accounts.slavesOf(master.id);
      if (followers.length === 0) continue;
      const claimed = new Set<string>();
      for (const position of master.listPositions()) {
        const keys = new Set<string>();
        if (position.clientId) keys.add(position.clientId);
        const copyId = CopyTradeEngine.copyClientId(position.ticket);
        if (copyId) keys.add(copyId);
        const existing = this.links.get(position.id) ?? [];
        const linked = new Set(existing.map((l) => l.positionId));
        const found: Link[] = [];
        for (const follower of followers) {
          for (const copy of follower.listPositions()) {
            if (!copy.clientId || !keys.has(copy.clientId)) continue;
            claimed.add(copy.id);
            if (linked.has(copy.id)) continue;
            copy.sourceId = position.id;
            found.push({ accountId: follower.id, positionId: copy.id });
          }
        }
        if (found.length > 0) this.links.set(position.id, [...existing, ...found]);
      }
      if (!master.connected) continue;
      for (const follower of followers) {
        if (!follower.connected) continue;
        for (const copy of follower.listPositions()) {
          if (copy.origin !== 'copy' || claimed.has(copy.id) || this.orphansReported.has(copy.id)) continue;
          this.orphansReported.add(copy.id);
          this.journal.write(
            'warn',
            follower.id,
            `#${copy.ticket} on ${follower.config.name} is a copy whose master position is no longer open — close it if the master closed while the terminal was offline`,
          );
        }
      }
    }
  }

  private readonly orphansReported = new Set<string>();

  recent(): DispatchReport[] {
    return this.reports;
  }

  private record(report: DispatchReport): void {
    this.reports.unshift(report);
    if (this.reports.length > 50) this.reports.pop();
    this.emit('dispatch', report);
  }

  private followers(master: TradingAccount): TradingAccount[] {
    return this.accounts.slavesOf(master.id).filter((f) => f.connected);
  }

  linksOf(masterPositionId: string): Link[] {
    return this.links.get(masterPositionId) ?? [];
  }

  /* ------------------------------------------------------------------ */
  /* Mapping one order onto a follower                                   */
  /* ------------------------------------------------------------------ */

  private resolveVolume(settings: CopySettings, master: TradingAccount, slave: TradingAccount, volume: number, symbol: string): number {
    let target: number;
    switch (settings.sizing) {
      case 'fixed':
        target = settings.fixedLot;
        break;
      case 'balance-ratio': {
        const ratio = master.balance > 0 ? slave.balance / master.balance : 1;
        target = volume * ratio;
        break;
      }
      default:
        target = volume * settings.multiplier;
    }
    const bounded = Math.min(settings.maxLot, Math.max(settings.minLot, target));
    return roundLot(slave.spec(symbol), bounded);
  }

  /** The follower's own name for the master's instrument. */
  private followerSymbol(slave: TradingAccount, masterSymbol: string): string {
    return baseSymbol(slave.symbol) === baseSymbol(masterSymbol) ? slave.symbol : masterSymbol;
  }

  private allowed(settings: CopySettings, symbol: string): boolean {
    if (settings.symbolWhitelist.length === 0) return true;
    const base = baseSymbol(symbol);
    return settings.symbolWhitelist.some((s) => baseSymbol(s) === base);
  }

  /**
   * Absolute stop and target for an order. Money-based stops are converted at
   * the reference price so every account holds its stop at the same price
   * level, whatever lot size it trades.
   */
  private levels(master: TradingAccount, req: OpenRequest, reference: number): { sl: number | null; tp: number | null } {
    if ((req.stopLoss !== undefined && req.stopLoss !== null) || (req.takeProfit !== undefined && req.takeProfit !== null)) {
      return { sl: req.stopLoss ?? null, tp: req.takeProfit ?? null };
    }
    if (!req.stopLossUsd && !req.takeProfitUsd) return { sl: null, tp: null };
    const spec = master.spec(req.symbol);
    const derived = stopLevels(spec, req.side, req.volume, reference, req.stopLossUsd ?? null, req.takeProfitUsd ?? null);
    return { sl: derived.stopLoss, tp: derived.takeProfit };
  }

  /** The order a follower should send for the master's order, or null if it should not copy it. */
  mirrorRequest(master: TradingAccount, slave: TradingAccount, req: OpenRequest, reference: number, sourceId: string | null): OpenRequest | null {
    const settings = slave.config.copy;
    if (!settings.enabled || !this.allowed(settings, req.symbol)) return null;
    const symbol = this.followerSymbol(slave, req.symbol);
    const side: Side = settings.reverse ? (req.side === 'buy' ? 'sell' : 'buy') : req.side;
    // A burst copied by balance keeps the lot and scales the count: a
    // follower runs the burst its own balance would, not a shrunken master's.
    const burstByBalance = req.burst !== undefined && settings.sizing === 'balance-ratio';
    if (burstByBalance && req.burst!.index >= burstSize(slave.balance, req.burst!.perStep, req.burst!.step, req.burst!.max)) return null;
    const volume = burstByBalance ? roundLot(slave.spec(symbol), req.volume) : this.resolveVolume(settings, master, slave, req.volume, symbol);
    const { sl, tp } = this.levels(master, req, reference);
    const spec = slave.spec(symbol);
    // A reversed copy swaps the levels: where the master takes profit, the follower stops out.
    const rawSl = settings.reverse ? tp : sl;
    const rawTp = settings.reverse ? sl : tp;
    return {
      symbol,
      side,
      volume,
      stopLoss: settings.copyStopLoss && rawSl !== null ? roundPrice(spec, rawSl) : null,
      takeProfit: settings.copyTakeProfit && rawTp !== null ? roundPrice(spec, rawTp) : null,
      origin: 'copy',
      comment: req.comment ?? '',
      basketIndex: req.basketIndex,
      recoveryLayer: req.recoveryLayer,
      sourceId,
      magic: req.magic,
      clientId: req.clientId ?? null,
      slippagePoints: req.slippagePoints,
    };
  }

  /* ------------------------------------------------------------------ */
  /* Dispatch: one order, every account, the same instant                */
  /* ------------------------------------------------------------------ */

  /**
   * Opens a position on the master and mirrors it onto every follower.
   * Resolves with the master's result; followers are linked as they answer.
   */
  async open(master: TradingAccount, req: OpenRequest): Promise<OpenResult> {
    const followers = this.followers(master);
    if (this.config.mode !== 'simultaneous' || followers.length === 0) {
      // Copy-after-fill: the fill event mirrors it.
      return master.submit(req);
    }

    const clientId = req.clientId ?? newClientId();
    this.dispatched.add(clientId);
    const masterReq: OpenRequest = { ...req, clientId };
    const quote = master.quote();
    const reference = quote ? (req.side === 'buy' ? quote.ask : quote.bid) : 0;

    const plans = followers
      .map((f) => ({ account: f, req: this.mirrorRequest(master, f, masterReq, reference, null) }))
      .filter((p): p is { account: TradingAccount; req: OpenRequest } => p.req !== null);

    const firstSend = now();
    const masterPromise = master.submit(masterReq).then((result) => {
      master.recordLatency(now() - firstSend);
      return { result, ackMs: now() - firstSend };
    });
    const followerPromises = plans.map((plan) => {
      const sent = now();
      return plan.account.submit(plan.req).then(
        (result) => {
          plan.account.recordLatency(now() - sent);
          return { plan, result, ackMs: now() - sent };
        },
        (err: unknown) => ({ plan, result: { ok: false, error: err instanceof Error ? err.message : String(err) } as OpenResult, ackMs: now() - sent }),
      );
    });
    const sendSpreadMs = now() - firstSend;

    const master_ = await masterPromise;
    void Promise.all(followerPromises).then((outcomes) =>
      this.settleOpen(master, masterReq, master_.result, master_.ackMs, outcomes, sendSpreadMs, clientId),
    );
    return master_.result;
  }

  private async settleOpen(
    master: TradingAccount,
    req: OpenRequest,
    masterResult: OpenResult,
    masterAck: number,
    outcomes: { plan: { account: TradingAccount; req: OpenRequest }; result: OpenResult; ackMs: number }[],
    sendSpreadMs: number,
    clientId: string,
  ): Promise<void> {
    const report: DispatchReport = {
      id: uid('dsp'),
      time: Date.now(),
      action: 'open',
      symbol: req.symbol,
      side: req.side,
      sendSpreadMs: Math.round(sendSpreadMs * 1000) / 1000,
      legs: [
        {
          accountId: master.id,
          role: 'master',
          ok: masterResult.ok,
          ackMs: Math.round(masterAck),
          error: masterResult.ok ? null : masterResult.error,
        },
      ],
    };

    const masterPosition = masterResult.ok ? masterResult.position : null;
    const links: Link[] = [];
    for (const { plan, result, ackMs } of outcomes) {
      report.legs.push({
        accountId: plan.account.id,
        role: 'follower',
        ok: result.ok,
        ackMs: Math.round(ackMs),
        error: result.ok ? null : result.error,
      });
      if (!result.ok) {
        this.journal.write('warn', plan.account.id, `Copy rejected by ${plan.account.config.name}: ${result.error}`);
        continue;
      }
      const position = result.position;
      if (!masterPosition) {
        if (this.config.cancelOrphans) {
          await plan.account.submitClose(position.id, 'copy');
          this.journal.write('warn', plan.account.id, `Follower fill closed — the master rejected the same order (${masterResult.ok ? '' : masterResult.error})`);
        }
        continue;
      }
      position.sourceId = masterPosition.id;
      const slippage = Math.abs(position.openPrice - masterPosition.openPrice);
      const maxSlippage = plan.account.config.copy.maxSlippage;
      if (maxSlippage > 0 && slippage > maxSlippage) {
        await plan.account.submitClose(position.id, 'copy');
        this.journal.write('warn', plan.account.id, `Copy cancelled — filled ${slippage.toFixed(2)} away from the master, over the ${maxSlippage.toFixed(2)} limit`);
        continue;
      }
      links.push({ accountId: plan.account.id, positionId: position.id });
      this.journal.write(
        'copy',
        plan.account.id,
        `Mirrored ${position.side.toUpperCase()} ${position.volume.toFixed(2)} ${position.symbol} @ ${position.openPrice.toFixed(2)} — broker answered in ${Math.round(ackMs)} ms`,
      );
    }

    if (masterPosition) {
      if (links.length > 0) {
        const existing = this.links.get(masterPosition.id) ?? [];
        this.links.set(masterPosition.id, [...existing, ...links]);
      }
      // The master may already have closed while followers were answering.
      if (!master.getPosition(masterPosition.id) && links.length > 0) {
        await this.closeLinked(masterPosition.id, 'copy');
      }
    }
    this.dispatched.delete(clientId);
    this.record(report);
  }

  /** Closes a master position and its copies in the same instant. */
  async close(master: TradingAccount, positionId: string, reason: CloseReason, volume?: number): Promise<ClosedTrade | null> {
    const position = master.getPosition(positionId);
    const links = this.links.get(positionId) ?? [];
    if (links.length === 0 || !position) return master.submitClose(positionId, reason, volume);

    const share = volume !== undefined && position.volume > 0 ? Math.min(1, volume / position.volume) : 1;
    const partial = share < 1 - 1e-9;
    if (!partial) this.closing.add(positionId);
    const firstSend = now();
    const masterPromise = master.submitClose(positionId, reason, volume).then((trade) => ({ trade, ackMs: now() - firstSend }));
    const followerPromises = links.map((link) => {
      const account = this.accounts.get(link.accountId);
      const copy = account?.getPosition(link.positionId);
      if (!account || !copy || !account.config.copy.copyCloses) return null;
      const copyVolume = partial ? roundLot(account.spec(copy.symbol), copy.volume * share) : undefined;
      const sent = now();
      return account.submitClose(link.positionId, 'copy', copyVolume).then((trade) => ({ account, trade, ackMs: now() - sent }));
    });
    const sendSpreadMs = now() - firstSend;
    const masterDone = await masterPromise;
    void Promise.all(followerPromises).then((outcomes) => {
      this.record({
        id: uid('dsp'),
        time: Date.now(),
        action: 'close',
        symbol: position.symbol,
        side: position.side,
        sendSpreadMs: Math.round(sendSpreadMs * 1000) / 1000,
        legs: [
          { accountId: master.id, role: 'master', ok: masterDone.trade !== null, ackMs: Math.round(masterDone.ackMs), error: masterDone.trade ? null : 'close rejected' },
          ...outcomes
            .filter((o): o is NonNullable<typeof o> => o !== null)
            .map((o) => ({ accountId: o.account.id, role: 'follower' as const, ok: o.trade !== null, ackMs: Math.round(o.ackMs), error: o.trade ? null : 'close rejected' })),
        ],
      });
      if (!partial) {
        this.links.delete(positionId);
        this.closing.delete(positionId);
      }
    });
    return masterDone.trade;
  }

  /** Moves the master's stop and target, and every copy's, at once. */
  async modify(master: TradingAccount, positionId: string, stopLoss: number | null, takeProfit: number | null): Promise<ActionResult> {
    const links = this.links.get(positionId) ?? [];
    this.modifying.add(positionId);
    const masterPromise = master.submitModify(positionId, stopLoss, takeProfit);
    const followerPromises = links.map((link) => this.modifyCopy(link, stopLoss, takeProfit));
    const result = await masterPromise;
    void Promise.all(followerPromises).finally(() => this.modifying.delete(positionId));
    return result;
  }

  private modifyCopy(link: Link, stopLoss: number | null, takeProfit: number | null): Promise<ActionResult> | null {
    const account = this.accounts.get(link.accountId);
    const copy = account?.getPosition(link.positionId);
    if (!account || !copy) return null;
    const settings = account.config.copy;
    const sl = settings.reverse ? takeProfit : stopLoss;
    const tp = settings.reverse ? stopLoss : takeProfit;
    return account.submitModify(
      link.positionId,
      settings.copyStopLoss ? sl : copy.stopLoss,
      settings.copyTakeProfit ? tp : copy.takeProfit,
    );
  }

  /* ------------------------------------------------------------------ */
  /* Events from the master's own stream                                 */
  /* ------------------------------------------------------------------ */

  private async onMasterOpen(position: Position, master: TradingAccount): Promise<void> {
    if (position.origin === 'copy') return;
    if (position.clientId && this.dispatched.has(position.clientId)) return;
    if (position.origin === 'external' && !this.mirrorExternal) return;
    const followers = this.followers(master);
    if (followers.length === 0) return;

    const req: OpenRequest = {
      symbol: position.symbol,
      side: position.side,
      volume: position.volume,
      stopLoss: position.stopLoss,
      takeProfit: position.takeProfit,
      stopLossUsd: position.stopLossUsd,
      takeProfitUsd: position.takeProfitUsd,
      origin: position.origin,
      comment: position.comment,
      basketIndex: position.basketIndex,
      recoveryLayer: position.recoveryLayer,
      magic: position.magic,
    };
    // Copies carry the master's ticket in their client id so they can be matched after a restart.
    const copyId = CopyTradeEngine.copyClientId(position.ticket);
    const tagged: OpenRequest = { ...req, clientId: copyId };
    // A follower already holding this trade (found on its own book) is never sent it twice.
    const holds = (f: TradingAccount) =>
      f.listPositions().some((p) => p.clientId !== null && (p.clientId === copyId || (position.clientId !== null && p.clientId === position.clientId)));
    const plans = followers
      .filter((f) => !holds(f))
      .map((f) => ({ account: f, req: this.mirrorRequest(master, f, tagged, position.openPrice, position.id) }))
      .filter((p): p is { account: TradingAccount; req: OpenRequest } => p.req !== null);
    if (plans.length === 0) return;

    // Every follower at once — never one after another.
    const firstSend = now();
    const outcomes = await Promise.all(
      plans.map((plan) => {
        const sent = now();
        return plan.account.submit(plan.req).then(
          (result) => {
            plan.account.recordLatency(now() - sent);
            return { plan, result, ackMs: now() - sent };
          },
          (err: unknown) => ({ plan, result: { ok: false, error: err instanceof Error ? err.message : String(err) } as OpenResult, ackMs: now() - sent }),
        );
      }),
    );
    await this.settleOpen(
      master,
      { ...req, clientId: null },
      { ok: true, position },
      0,
      outcomes,
      now() - firstSend,
      '',
    );
  }

  private async closeLinked(masterPositionId: string, reason: CloseReason): Promise<void> {
    const links = this.links.get(masterPositionId);
    if (!links) return;
    this.links.delete(masterPositionId);
    await Promise.all(
      links.map(async (link) => {
        const slave = this.accounts.get(link.accountId);
        if (!slave || !slave.config.copy.copyCloses) return;
        const closed = await slave.submitClose(link.positionId, reason);
        if (closed) {
          this.journal.write(
            'copy',
            slave.id,
            `Closed mirrored #${closed.ticket} with the master (${closed.netProfit >= 0 ? '+' : ''}${closed.netProfit.toFixed(2)})`,
          );
        }
      }),
    );
  }

  private async onMasterClose(_trade: ClosedTrade, position: Position, _master: TradingAccount): Promise<void> {
    // A close the dispatcher sent already went to the followers too.
    if (this.closing.has(position.id)) return;
    await this.closeLinked(position.id, 'copy');
  }

  private async onMasterPartial(trade: ClosedTrade, position: Position): Promise<void> {
    const links = this.links.get(position.id);
    if (!links || this.closing.has(position.id)) return;
    const before = position.volume + trade.volume;
    const share = before > 0 ? trade.volume / before : 0;
    await Promise.all(
      links.map(async (link) => {
        const slave = this.accounts.get(link.accountId);
        const copy = slave?.getPosition(link.positionId);
        if (!slave || !copy || !slave.config.copy.copyCloses) return;
        await slave.submitClose(link.positionId, 'copy', roundLot(slave.spec(copy.symbol), copy.volume * share));
      }),
    );
  }

  private async onMasterModify(position: Position): Promise<void> {
    if (this.modifying.has(position.id)) return;
    const links = this.links.get(position.id);
    if (!links) return;
    await Promise.all(links.map((link) => this.modifyCopy(link, position.stopLoss, position.takeProfit)));
  }
}
