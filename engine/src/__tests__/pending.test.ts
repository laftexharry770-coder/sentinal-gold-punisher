import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AccountConfig, DispatchReport, Tick } from '@sentinal/shared';
import { TradingAccount, type ActionResult } from '../broker/account.js';
import { AccountManager } from '../broker/manager.js';
import { CopyTradeEngine } from '../engine/copier.js';
import { Journal } from '../journal.js';

/** An account whose broker takes a moment to answer a modify, recording each price it is sent. */
class LaggyAccount extends TradingAccount {
  modifies: number[] = [];
  constructor(
    config: AccountConfig,
    private readonly modifyDelayMs: number,
  ) {
    super(config);
  }
  override async modifyPending(
    id: string,
    price: number,
    stopLoss: number | null,
    takeProfit: number | null,
    expiration?: number | null,
  ): Promise<ActionResult> {
    this.modifies.push(price);
    if (this.modifyDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.modifyDelayMs));
    return super.modifyPending(id, price, stopLoss, takeProfit, expiration);
  }
}

const tick = (bid: number): Tick => ({ symbol: 'XAUUSD', bid, ask: +(bid + 0.2).toFixed(2), time: Date.now() });
const settle = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

function setup(followerCount = 1, modifyDelayMs = 0) {
  const journal = new Journal();
  const accounts = new AccountManager();
  accounts.registerProvider('metaapi', (config) => new LaggyAccount(config, config.role === 'master' ? 0 : modifyDelayMs));
  const copier = new CopyTradeEngine(accounts, journal);
  const master = accounts.add({ name: 'Master', provider: 'metaapi', login: '1', server: 'A', role: 'master', initialBalance: 10_000 }) as LaggyAccount;
  const followers = Array.from(
    { length: followerCount },
    (_, i) =>
      accounts.add({
        name: `Follower ${i + 1}`,
        provider: 'metaapi',
        login: String(10 + i),
        server: 'B',
        role: 'slave',
        initialBalance: 10_000,
        copy: { enabled: true, masterId: master.id, sizing: 'multiplier', multiplier: 2, maxSlippage: 0 },
      }) as LaggyAccount,
  );
  accounts.onTick(tick(3300));
  const reports: DispatchReport[] = [];
  copier.on('dispatch', (r: DispatchReport) => reports.push(r));
  const buyStop = () =>
    copier.placePending(master, {
      symbol: 'XAUUSD',
      type: 'buy-stop',
      volume: 0.1,
      openPrice: 3301,
      stopLoss: 3300.5,
      takeProfit: 3302,
      comment: 'Angel Bot',
    });
  return { journal, accounts, copier, master, followers, reports, buyStop };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('mirrored pending orders', () => {
  it('places the same stop order on every follower in the same instant', async () => {
    const { master, followers, reports, buyStop } = setup(2);
    const placed = await buyStop();
    expect(placed.ok).toBe(true);
    await settle();
    const [original] = master.listOrders();
    for (const f of followers) {
      const [copy] = f.listOrders();
      expect(copy).toMatchObject({ type: 'buy-stop', openPrice: 3301, stopLoss: 3300.5, takeProfit: 3302, volume: 0.2, origin: 'copy' });
      expect(copy!.clientId).toBe(original!.clientId);
    }
    const report = reports.find((r) => r.action === 'pending');
    expect(report?.legs.map((l) => `${l.role}:${l.ok}`)).toEqual(['master:true', 'follower:true', 'follower:true']);
  });

  it('moves the copies with the master, sending a busy follower only the newest price', async () => {
    const { copier, master, followers, buyStop } = setup(1, 30);
    await buyStop();
    await settle();
    const orderId = master.listOrders()[0]!.id;
    // An EA trailing its stop re-prices it on five quick ticks.
    for (const price of [3300.9, 3300.8, 3300.7, 3300.6, 3300.55]) {
      const moved = await copier.modifyPending(master, orderId, price, +(price - 0.5).toFixed(2), +(price + 1).toFixed(2));
      expect(moved.ok).toBe(true);
    }
    expect(master.listOrders()[0]!.openPrice).toBe(3300.55);
    await settle(120);
    const follower = followers[0]!;
    // One request while the first was in flight, then straight to the newest.
    expect(follower.modifies).toEqual([3300.9, 3300.55]);
    expect(follower.listOrders()[0]).toMatchObject({ openPrice: 3300.55, stopLoss: 3300.05, takeProfit: 3301.55 });
  });

  it('cancels the copies with the master', async () => {
    const { copier, master, followers, reports, buyStop } = setup(2);
    await buyStop();
    await settle();
    const cancelled = await copier.cancelPending(master, master.listOrders()[0]!.id);
    expect(cancelled.ok).toBe(true);
    await settle();
    expect(master.listOrders()).toHaveLength(0);
    for (const f of followers) expect(f.listOrders()).toHaveLength(0);
    expect(reports.some((r) => r.action === 'cancel')).toBe(true);
  });

  it('fills every copy on the same quote as the master, and links them for the close', async () => {
    const { accounts, master, followers, buyStop } = setup(2);
    await buyStop();
    await settle();
    accounts.onTick(tick(3301));
    await settle();
    const [position] = master.listPositions();
    expect(position?.openPrice).toBe(3301.2);
    for (const f of followers) {
      const [copy] = f.listPositions();
      expect(copy).toMatchObject({ side: 'buy', openPrice: 3301.2, volume: 0.2, origin: 'copy', sourceId: position!.id });
    }
    // Closing the master closes the copies.
    await master.submitClose(position!.id, 'manual');
    await settle();
    for (const f of followers) {
      expect(f.listPositions()).toHaveLength(0);
      expect(f.history[0]?.reason).toBe('copy');
    }
  });

  it("fills a follower at market when its broker's price never reached the stop", async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const { master, followers, journal, buyStop } = setup(1);
    await buyStop();
    await vi.advanceTimersByTimeAsync(0);
    // Only the master's broker trades through the stop.
    master.onTick(tick(3301));
    const follower = followers[0]!;
    follower.onTick(tick(3300.6));
    expect(master.listPositions()).toHaveLength(1);
    expect(follower.listPositions()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1500);
    expect(follower.listOrders()).toHaveLength(0);
    const [copy] = follower.listPositions();
    expect(copy).toMatchObject({ side: 'buy', volume: 0.2, sourceId: master.listPositions()[0]!.id });
    expect(journal.list().some((l) => /mirrored at market/.test(l.message))).toBe(true);
  });

  it("closes a follower's early fill when the master's order is cancelled", async () => {
    const { copier, master, followers, buyStop } = setup(1);
    await buyStop();
    await settle();
    const follower = followers[0]!;
    follower.onTick(tick(3301));
    await settle();
    expect(follower.listPositions()).toHaveLength(1);
    await copier.cancelPending(master, master.listOrders()[0]!.id);
    await settle();
    expect(follower.listPositions()).toHaveLength(0);
    expect(follower.history[0]?.reason).toBe('copy');
  });

  it("withdraws the copies when the master's broker refuses the order", async () => {
    const { copier, master, followers } = setup(1);
    const refused = await copier.placePending(master, { symbol: 'XAUUSD', type: 'buy-stop', volume: 0.1, openPrice: 3299 });
    expect(refused.ok).toBe(false);
    await settle();
    expect(followers[0]!.listOrders()).toHaveLength(0);
  });
});
