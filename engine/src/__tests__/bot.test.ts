import { describe, expect, it } from 'vitest';
import type { Tick } from '@sentinal/shared';
import { AccountManager } from '../broker/manager.js';
import { BotEngine } from '../engine/bot.js';
import { CopyTradeEngine } from '../engine/copier.js';
import { Journal } from '../journal.js';
import { createRng, gaussian } from '../util.js';

/**
 * Deterministic random walk with a mild drift — the same shape the live feed
 * produces, so price crosses its own fast average and the scalper gets entries.
 */
function trendingTicks(count: number, seed = 42, start = 3300): Tick[] {
  const base = 1_760_000_000_000;
  const rng = createRng(seed);
  const ticks: Tick[] = [];
  let mid = start;
  for (let i = 0; i < count; i += 1) {
    mid += gaussian(rng) * 0.12 + 0.01;
    ticks.push({
      symbol: 'XAUUSD',
      bid: Number((mid - 0.11).toFixed(2)),
      ask: Number((mid + 0.11).toFixed(2)),
      time: base + i * 400,
    });
  }
  return ticks;
}

function harness() {
  const journal = new Journal();
  const accounts = new AccountManager();
  const bot = new BotEngine(accounts, journal);
  // These cases are about multi-position mechanics, so they pin the lot size
  // rather than letting equity-based sizing choose it. Sizing has its own suite.
  bot.updateConfig({ sizing: 'fixed' });
  return { journal, accounts, bot };
}

async function run(
  ctx: ReturnType<typeof harness>,
  ticks: Tick[],
  onTick?: (tick: Tick) => void,
): Promise<number> {
  let peak = 0;
  for (const tick of ticks) {
    ctx.accounts.onTick(tick);
    await ctx.bot.onTick(tick, false);
    peak = Math.max(peak, ctx.accounts.allPositions().length);
    onTick?.(tick);
  }
  return peak;
}

describe('BotEngine multi-position execution', () => {
  it('fires several legs per signal and keeps them open together', async () => {
    const ctx = harness();
    ctx.accounts.add({ name: 'Master', login: '1', server: 'test', role: 'master', initialBalance: 20_000 });
    ctx.bot.updateConfig({
      entriesPerSignal: 3,
      // Caps are set clear of the burst size so no burst is truncated.
      maxConcurrentPositions: 60,
      maxPositionsPerDirection: 30,
      signalCooldownMs: 0,
      entrySpacingUsd: 0.2,
      takeProfitUsd: 500, // keep legs open so the concurrent book can be observed
      stopLossUsd: 500,
      basketTakeProfitUsd: null,
    });
    ctx.bot.start();

    const peak = await run(ctx, trendingTicks(160));

    expect(ctx.bot.stats().tradesOpened).toBeGreaterThanOrEqual(3);
    expect(peak).toBeGreaterThanOrEqual(3);
    // Legs arrive in bursts of entriesPerSignal.
    expect(ctx.bot.stats().tradesOpened % 3).toBe(0);
  });

  it('never exceeds the concurrent position cap', async () => {
    const ctx = harness();
    ctx.accounts.add({ name: 'Master', login: '1', server: 'test', role: 'master', initialBalance: 20_000 });
    ctx.bot.updateConfig({
      entriesPerSignal: 4,
      maxConcurrentPositions: 5,
      maxPositionsPerDirection: 5,
      signalCooldownMs: 0,
      entrySpacingUsd: 0,
      takeProfitUsd: 500,
      stopLossUsd: 500,
      basketTakeProfitUsd: null,
    });
    ctx.bot.start();

    const peak = await run(ctx, trendingTicks(200));
    expect(peak).toBeGreaterThan(0);
    expect(peak).toBeLessThanOrEqual(5);
  });

  it('honours the per-direction cap independently of the global cap', async () => {
    const ctx = harness();
    ctx.accounts.add({ name: 'Master', login: '1', server: 'test', role: 'master', initialBalance: 20_000 });
    ctx.bot.updateConfig({
      entriesPerSignal: 5,
      maxConcurrentPositions: 20,
      maxPositionsPerDirection: 2,
      signalCooldownMs: 0,
      entrySpacingUsd: 0,
      takeProfitUsd: 500,
      stopLossUsd: 500,
      basketTakeProfitUsd: null,
    });
    ctx.bot.start();

    let maxLongs = 0;
    await run(ctx, trendingTicks(160), () => {
      const longs = ctx.accounts.allPositions().filter((p) => p.side === 'buy').length;
      maxLongs = Math.max(maxLongs, longs);
    });
    expect(maxLongs).toBeGreaterThan(0);
    expect(maxLongs).toBeLessThanOrEqual(2);
  });

  it('keeps stacked entries apart by the configured spacing', async () => {
    const ctx = harness();
    ctx.accounts.add({ name: 'Master', login: '1', server: 'test', role: 'master', initialBalance: 20_000 });
    ctx.bot.updateConfig({
      entriesPerSignal: 1,
      maxConcurrentPositions: 10,
      maxPositionsPerDirection: 10,
      signalCooldownMs: 0,
      entrySpacingUsd: 1.5,
      takeProfitUsd: 500,
      stopLossUsd: 500,
      basketTakeProfitUsd: null,
    });
    ctx.bot.start();

    await run(ctx, trendingTicks(220));
    const longs = ctx.accounts
      .allPositions()
      .filter((p) => p.side === 'buy')
      .map((p) => p.openPrice)
      .sort((a, b) => a - b);

    for (let i = 1; i < longs.length; i += 1) {
      expect(longs[i]! - longs[i - 1]!).toBeGreaterThanOrEqual(1.5);
    }
  });

  it('closes the whole basket together once the combined target is reached', async () => {
    const ctx = harness();
    const account = ctx.accounts.add({ name: 'Master', login: '1', server: 'test', role: 'master', initialBalance: 20_000 });
    const open: Tick = { symbol: 'XAUUSD', bid: 3300, ask: 3300.2, time: 1_760_000_000_000 };
    ctx.accounts.onTick(open);
    for (let i = 0; i < 3; i += 1) {
      account.open({ symbol: 'XAUUSD', side: 'buy', volume: 0.1, origin: 'bot', basketIndex: i });
    }
    expect(account.listPositions()).toHaveLength(3);

    ctx.bot.updateConfig({ basketTakeProfitUsd: 5, basketStopLossUsd: null });
    ctx.bot.start();

    // A one dollar rally is worth $30 across three 0.1-lot legs.
    const rally: Tick = { symbol: 'XAUUSD', bid: 3301, ask: 3301.2, time: open.time + 400 };
    ctx.accounts.onTick(rally);
    await ctx.bot.onTick(rally, false);

    expect(account.listPositions()).toHaveLength(0);
    const exits = account.history.filter((t) => t.reason === 'basket-tp');
    expect(exits).toHaveLength(3);
    expect(exits.reduce((sum, t) => sum + t.netProfit, 0)).toBeGreaterThan(5);
  });

  it('flattens the basket when the combined stop is breached', async () => {
    const ctx = harness();
    const account = ctx.accounts.add({ name: 'Master', login: '1', server: 'test', role: 'master', initialBalance: 20_000 });
    const open: Tick = { symbol: 'XAUUSD', bid: 3300, ask: 3300.2, time: 1_760_000_000_000 };
    ctx.accounts.onTick(open);
    for (let i = 0; i < 2; i += 1) {
      account.open({ symbol: 'XAUUSD', side: 'buy', volume: 0.1, origin: 'bot', basketIndex: i });
    }

    ctx.bot.updateConfig({ basketTakeProfitUsd: null, basketStopLossUsd: 10 });
    ctx.bot.start();

    const drop: Tick = { symbol: 'XAUUSD', bid: 3299, ask: 3299.2, time: open.time + 400 };
    ctx.accounts.onTick(drop);
    await ctx.bot.onTick(drop, false);

    expect(account.listPositions()).toHaveLength(0);
    expect(account.history.filter((t) => t.reason === 'basket-sl')).toHaveLength(2);
  });

  it('mirrors every leg of a burst onto the follower account', async () => {
    const ctx = harness();
    new CopyTradeEngine(ctx.accounts, ctx.journal);
    const master = ctx.accounts.add({ name: 'Master', login: '1', server: 'test', role: 'master', initialBalance: 20_000 });
    const follower = ctx.accounts.add({
      name: 'Follower',
      login: '2',
      server: 'test',
      role: 'slave',
      initialBalance: 20_000,
      copy: { enabled: true, masterId: master.id, sizing: 'multiplier', multiplier: 2, maxSlippage: 0 },
    });

    ctx.bot.updateConfig({
      entriesPerSignal: 3,
      maxConcurrentPositions: 9,
      maxPositionsPerDirection: 9,
      signalCooldownMs: 0,
      entrySpacingUsd: 0,
      takeProfitUsd: 500,
      stopLossUsd: 500,
      basketTakeProfitUsd: null,
    });
    ctx.bot.start();

    await run(ctx, trendingTicks(120));

    const masterLegs = master.listPositions();
    const followerLegs = follower.listPositions();
    expect(masterLegs.length).toBeGreaterThan(0);
    expect(followerLegs).toHaveLength(masterLegs.length);
    expect(followerLegs.every((p) => p.origin === 'copy')).toBe(true);
    expect(followerLegs.every((p) => p.volume === masterLegs[0]!.volume * 2)).toBe(true);
  });

  it('propagates master closes to the follower', async () => {
    const ctx = harness();
    new CopyTradeEngine(ctx.accounts, ctx.journal);
    const master = ctx.accounts.add({ name: 'Master', login: '1', server: 'test', role: 'master', initialBalance: 20_000 });
    const follower = ctx.accounts.add({
      name: 'Follower',
      login: '2',
      server: 'test',
      role: 'slave',
      initialBalance: 20_000,
      copy: { enabled: true, masterId: master.id, sizing: 'fixed', fixedLot: 0.01, maxSlippage: 0 },
    });

    ctx.bot.updateConfig({
      entriesPerSignal: 2,
      signalCooldownMs: 0,
      entrySpacingUsd: 0,
      takeProfitUsd: 500,
      stopLossUsd: 500,
      basketTakeProfitUsd: null,
    });
    ctx.bot.start();
    await run(ctx, trendingTicks(80));
    expect(follower.listPositions().length).toBeGreaterThan(0);

    master.closeAll('manual');
    // Replication is async; let the queued closes settle.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(follower.listPositions()).toHaveLength(0);
  });

  it('works one recovery at a time instead of stacking layers on the same deficit', async () => {
    const ctx = harness();
    const account = ctx.accounts.add({ name: 'Master', login: '1', server: 'test', role: 'master', initialBalance: 20_000 });
    ctx.bot.updateConfig({
      entriesPerSignal: 1,
      maxConcurrentPositions: 10,
      maxPositionsPerDirection: 10,
      signalCooldownMs: 0,
      entrySpacingUsd: 0,
      // Tight stop, distant target: the book books losses and builds a deficit.
      stopLossUsd: 0.4,
      takeProfitUsd: 40,
      basketTakeProfitUsd: null,
      zeroLoss: { ...ctx.bot.config.zeroLoss, enabled: true, requireSignalAlignment: true },
    });
    ctx.bot.start();

    let maxRecoveryLegs = 0;
    await run(ctx, trendingTicks(400, 7), () => {
      const legs = account.listPositions().filter((p) => p.origin === 'recovery').length;
      maxRecoveryLegs = Math.max(maxRecoveryLegs, legs);
    });

    const released = ctx.bot.listRecoveries().filter((t) => t.status === 'fired');
    expect(released.length).toBeGreaterThan(0);
    // A single plan may split into simultaneous legs, but layers never overlap.
    expect(maxRecoveryLegs).toBeLessThanOrEqual(ctx.bot.config.zeroLoss.maxRecoveryLayers);
    expect(new Set(released.map((t) => t.layer)).size).toBe(released.length);
  });

  it('lets an account linked mid-session mirror immediately', async () => {
    const ctx = harness();
    new CopyTradeEngine(ctx.accounts, ctx.journal);
    const master = ctx.accounts.add({ name: 'Master', login: '1', server: 'test', role: 'master', initialBalance: 20_000 });
    ctx.accounts.onTick({ symbol: 'XAUUSD', bid: 3300, ask: 3300.2, time: Date.now() });

    // Linked after the feed is already running, with no explicit master.
    const follower = ctx.accounts.add({
      name: 'Late follower',
      login: '2',
      server: 'test',
      role: 'slave',
      initialBalance: 20_000,
      copy: { enabled: true, sizing: 'multiplier', multiplier: 2, maxSlippage: 0 },
    });
    expect(follower.config.copy.masterId).toBe(master.id);

    await ctx.bot.manualOrder(master, {
      symbol: 'XAUUSD',
      side: 'buy',
      volume: 0.01,
      legs: 3,
      stopLossUsd: null,
      takeProfitUsd: null,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(follower.listPositions()).toHaveLength(3);
    expect(follower.listPositions().every((p) => p.volume === 0.02)).toBe(true);
  });

  it('fires the requested number of manual legs in one ticket', async () => {
    const ctx = harness();
    const account = ctx.accounts.add({ name: 'Solo', login: '1', server: 'test', initialBalance: 20_000 });
    ctx.accounts.onTick({ symbol: 'XAUUSD', bid: 3300, ask: 3300.2, time: Date.now() });

    const result = await ctx.bot.manualOrder(account, {
      symbol: 'XAUUSD',
      side: 'buy',
      volume: 0.02,
      legs: 6,
      stopLossUsd: 2,
      takeProfitUsd: 1,
    });

    expect(result.opened).toHaveLength(6);
    expect(result.errors).toHaveLength(0);
    expect(account.listPositions()).toHaveLength(6);
    expect(account.listPositions().every((p) => p.volume === 0.02)).toBe(true);
  });
});
