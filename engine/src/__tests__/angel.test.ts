import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { compileMql5 } from '@sentinal/mql5';
import { loadStrategy, startBot, stopBot, updateBotConfig } from '../commands.js';
import { createRuntime } from '../runtime.js';

const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const source = readFileSync(fileURLToPath(new URL('../../../mql5/samples/Angel_Bot.mq5', import.meta.url)), 'utf8');

/** Two decimals exactly: what a gold price on the broker's tick grid looks like. */
const onGrid = (v: number | null) => v === null || Math.abs(v * 100 - Math.round(v * 100)) < 1e-6;

describe('Angel Bot', () => {
  it('compiles with every input it declares', () => {
    const compiled = compileMql5(source, 'Angel_Bot.mq5');
    if (!compiled.ok) throw new Error(compiled.diagnostics.map((d) => `${d.line}: ${d.message}`).join('\n'));
    expect(compiled.inputs).toHaveLength(28);
    expect(compiled.inputs.find((i) => i.name === 'InpLots')?.defaultValue).toBe(0.1);
    expect(compiled.inputs.find((i) => i.name === 'InpComment')?.defaultValue).toBe('Angel Bot');
  });

  it('brackets price with stop orders, mirrors them to the follower at the same prices, and copies every fill', async () => {
    const runtime = createRuntime({ seedPrice: 4350, tickIntervalMs: 50, seed: 3, historyBars: 400 });
    const master = runtime.accounts.add({ name: 'Master', login: '1', server: 'sim', role: 'master', initialBalance: 1000, leverage: 2000 });
    const follower = runtime.accounts.add({
      name: 'Follower',
      login: '2',
      server: 'sim',
      role: 'slave',
      initialBalance: 1000,
      leverage: 2000,
      copy: { enabled: true, masterId: master.id, sizing: 'multiplier', multiplier: 1, maxSlippage: 0 },
    });
    const loaded = await loadStrategy(runtime, [{ name: 'Angel_Bot.mq5', content: source }]);
    expect(loaded.kind === 'mql5' && loaded.result.ok).toBe(true);
    updateBotConfig(runtime, { expertTimeframe: 1, expertInputs: {}, maxDailyLossUsd: null, maxDailyTrades: null });
    startBot(runtime);
    for (let i = 0; i < 100 && runtime.strategyInfo().status !== 'running'; i += 1) await settle(5);
    expect(runtime.strategyInfo().status).toBe('running');

    let price = runtime.feed.quote?.bid ?? 4350;
    let time = Date.now();
    let seed = 11;
    let sawBracket = false;
    let mirroredAtSamePrice = true;
    for (let i = 0; i < 3000; i += 1) {
      seed = (seed * 1103515245 + 12345) >>> 0;
      price += (seed / 4294967296 - 0.49) * 0.12;
      time += 700;
      runtime.feed.pushTick({ symbol: 'XAUUSD', bid: +price.toFixed(2), ask: +(price + 0.12).toFixed(2), time });
      await runtime.expert.idle();
      const orders = master.listOrders();
      if (orders.length === 2 && orders.some((o) => o.type === 'buy-stop') && orders.some((o) => o.type === 'sell-stop')) {
        sawBracket = true;
        const copies = follower.listOrders();
        await settle(0);
        if (copies.length === 2) {
          for (const o of orders) {
            const twin = copies.find((c) => c.type === o.type);
            if (!twin || twin.openPrice !== o.openPrice || twin.stopLoss !== o.stopLoss) mirroredAtSamePrice = false;
          }
        }
      }
      for (const o of orders) expect(onGrid(o.openPrice) && onGrid(o.stopLoss) && onGrid(o.takeProfit)).toBe(true);
    }
    await settle(20);

    expect(sawBracket).toBe(true);
    expect(mirroredAtSamePrice).toBe(true);
    expect(runtime.journal.list().filter((l) => l.level === 'error')).toHaveLength(0);
    // It trades: stop entries, top-ups, and exits by stop loss and take profit.
    expect(master.history.length).toBeGreaterThan(50);
    const reasons = new Set(master.history.map((t) => t.reason));
    expect(reasons.has('sl')).toBe(true);
    expect(reasons.has('tp')).toBe(true);
    expect(master.history.every((t) => t.volume === 0.1)).toBe(true);
    // The follower holds a copy of every trade, and nothing the master does not:
    // its own broker runs each copy's stops at the master's prices, so the two
    // books end identical.
    expect(follower.history.length).toBe(master.history.length);
    expect(follower.history.every((t) => t.origin === 'copy')).toBe(true);
    const byTime = (a: { openTime: number; closeTime: number }, b: { openTime: number; closeTime: number }) =>
      a.openTime - b.openTime || a.closeTime - b.closeTime;
    const legs = (h: typeof master.history) =>
      [...h].sort(byTime).map((t) => `${t.side} ${t.openPrice} → ${t.closePrice} ${t.reason}`);
    expect(legs(follower.history)).toEqual(legs(master.history));
    expect(follower.balance).toBe(master.balance);
    expect(runtime.strategyInfo().comment).toMatch(/--- ANGEL BOT ---/);
    expect(runtime.copier.recent().some((r) => r.action === 'pending')).toBe(true);

    stopBot(runtime);
    await settle(20);
    expect(runtime.strategyInfo().status).toBe('stopped');
  });

  it('closes its own positions when the day locks, without a runtime error', async () => {
    const runtime = createRuntime({ seedPrice: 4350, tickIntervalMs: 50, seed: 5, historyBars: 400 });
    const master = runtime.accounts.add({ name: 'Master', login: '1', server: 'sim', role: 'master', initialBalance: 1000, leverage: 2000 });
    await loadStrategy(runtime, [{ name: 'Angel_Bot.mq5', content: source }]);
    // A day target and loss limit of $0.50: the first result locks the day and
    // the EA closes whatever is still open through its own ClosePosition.
    updateBotConfig(runtime, {
      expertTimeframe: 1,
      expertInputs: { InpDailyProfitTarget: 0.5, InpDailyLossLimit: 0.5, InpPositionsPerEntry: 3 },
      maxDailyLossUsd: null,
      maxDailyTrades: null,
    });
    startBot(runtime);
    for (let i = 0; i < 100 && runtime.strategyInfo().status !== 'running'; i += 1) await settle(5);

    let price = runtime.feed.quote?.bid ?? 4350;
    let time = Date.now();
    let seed = 29;
    // The EA's own PositionClose is booked as a close from the terminal, not a stop or target.
    const closedByEa = () => master.history.some((t) => t.reason === 'manual');
    for (let i = 0; i < 1500 && !closedByEa(); i += 1) {
      seed = (seed * 1103515245 + 12345) >>> 0;
      price += (seed / 4294967296 - 0.49) * 0.12;
      time += 700;
      runtime.feed.pushTick({ symbol: 'XAUUSD', bid: +price.toFixed(2), ask: +(price + 0.12).toFixed(2), time });
      await runtime.expert.idle();
    }
    await settle(20);
    expect(runtime.journal.list().filter((l) => l.level === 'error').map((l) => l.message)).toEqual([]);
    expect(runtime.strategyInfo().status).toBe('running');
    expect(closedByEa()).toBe(true);
    expect(runtime.strategyInfo().comment).toMatch(/LOCKED/);
    expect(master.listPositions()).toHaveLength(0);
    stopBot(runtime);
    await settle(20);
  });
});
