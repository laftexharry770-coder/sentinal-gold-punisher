import { describe, expect, it } from 'vitest';
import { burstSize, type Candle } from '@sentinal/shared';
import { createRuntime } from '../runtime.js';

const settle = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

/** One-minute history drifting up (or down) so the trend reads clearly. */
function history(start: number, drift: number, bars = 120): Candle[] {
  const now = Math.floor(Date.now() / 60_000) * 60_000;
  return Array.from({ length: bars }, (_, i) => {
    const close = start + drift * i;
    return { time: now - (bars - i) * 60_000, open: close - drift, high: close + 0.2, low: close - 0.2, close, volume: 100 };
  });
}

function setup(opts: { balance: number; drift: number; followers?: { balance: number; sizing: 'multiplier' | 'balance-ratio' }[] }) {
  const runtime = createRuntime({ seedPrice: 0, tickIntervalMs: 1000, seed: 1, historyBars: 240, source: 'external' });
  const master = runtime.accounts.add({ name: 'Master', login: '1', server: 'sim', role: 'master', initialBalance: opts.balance, leverage: 100_000 });
  const followers = (opts.followers ?? []).map((f, i) =>
    runtime.accounts.add({
      name: `Follower ${i + 1}`,
      login: String(10 + i),
      server: 'sim',
      role: 'slave',
      initialBalance: f.balance,
      leverage: 100_000,
      copy: { enabled: true, masterId: master.id, sizing: f.sizing, multiplier: 1, maxSlippage: 0 },
    }),
  );
  const candles = history(4300, opts.drift);
  runtime.feed.seedCandles(candles);
  runtime.bot.prime(candles);
  let time = Date.now();
  const quote = async (bid: number, spread = 0.2) => {
    time += 1000;
    runtime.feed.pushTick({ symbol: 'XAUUSD', bid: +bid.toFixed(2), ask: +(bid + spread).toFixed(2), time });
    await settle(0);
    await settle(0);
  };
  return { runtime, master, followers, quote, last: candles[candles.length - 1]!.close };
}

describe('burst sizing', () => {
  it('opens 16 positions per $10 of balance, never more than 50', () => {
    expect(burstSize(10, 16, 10, 50)).toBe(16);
    expect(burstSize(90, 16, 10, 50)).toBe(50);
    expect(burstSize(341, 16, 10, 50)).toBe(50);
    expect(burstSize(5, 16, 10, 50)).toBe(8);
    expect(burstSize(0.5, 16, 10, 50)).toBe(0);
  });
});

describe('the burst model', () => {
  it('trades the way the recording does: 16 × 0.01 at $10, all out at +5.00, then 50 × 0.01', async () => {
    const { runtime, master, quote, last } = setup({ balance: 10, drift: 0.05 });
    expect(runtime.bot.config.strategy).toBe('burst');
    runtime.bot.start();

    await quote(last);
    const first = master.listPositions();
    expect(first).toHaveLength(16);
    for (const p of first) {
      expect(p).toMatchObject({ side: 'buy', volume: 0.01, origin: 'bot', stopLoss: null, comment: 'Sentinal BUY' });
      expect(p.takeProfit).toBeCloseTo(p.openPrice + 5, 2);
    }
    expect(new Set(first.map((p) => p.openPrice)).size).toBe(1);

    // Nothing new while the burst is open.
    await quote(last + 2);
    expect(master.listPositions()).toHaveLength(16);

    // Price reaches the take profit: every position closes, $5 each.
    await quote(last + 5.3);
    expect(master.listPositions().filter((p) => p.comment === 'Sentinal BUY' && p.openPrice === first[0]!.openPrice)).toHaveLength(0);
    const closed = master.history.slice(0, 16);
    expect(closed.every((t) => t.reason === 'tp' && Math.abs(t.profit - 5) < 1e-6)).toBe(true);
    expect(master.balance).toBeCloseTo(10 + 16 * 5 - 16 * 0.07, 2);

    // …and the next burst goes straight out, sized from the new balance: the 50 cap.
    await quote(last + 5.4);
    const second = master.listPositions();
    expect(second).toHaveLength(50);
    expect(second.every((p) => p.side === 'buy' && p.volume === 0.01)).toBe(true);
    expect(runtime.bot.stats().tradesOpened).toBe(66);
  });

  it('follows the trend down with sell bursts, and waits when there is no trend', async () => {
    const down = setup({ balance: 20, drift: -0.05 });
    down.runtime.bot.start();
    await down.quote(down.last);
    const sells = down.master.listPositions();
    expect(sells).toHaveLength(32);
    expect(sells.every((p) => p.side === 'sell' && Math.abs(p.takeProfit! - (p.openPrice - 5)) < 0.011)).toBe(true);

    const flat = setup({ balance: 20, drift: 0 });
    flat.runtime.bot.start();
    await flat.quote(flat.last);
    expect(flat.master.listPositions()).toHaveLength(0);
    expect(flat.runtime.bot.stats().lastSignal?.reason).toMatch(/no clear trend/);
  });

  it('keeps a fixed direction and an optional stop when set', async () => {
    const { runtime, master, quote, last } = setup({ balance: 10, drift: -0.05 });
    runtime.bot.updateConfig({ burst: { ...runtime.bot.config.burst, direction: 'buy', stopLossPrice: 2.5, maxPositions: 4 } });
    runtime.bot.start();
    await quote(last);
    const legs = master.listPositions();
    expect(legs).toHaveLength(4);
    expect(legs.every((p) => p.side === 'buy' && Math.abs(p.stopLoss! - (p.openPrice - 2.5)) < 0.011)).toBe(true);
  });

  it('copies every position to a multiplier follower, and sizes a balance-ratio follower from its own balance', async () => {
    const { runtime, master, followers, quote, last } = setup({
      balance: 90,
      drift: 0.05,
      followers: [
        { balance: 1000, sizing: 'multiplier' },
        { balance: 5, sizing: 'balance-ratio' },
      ],
    });
    runtime.bot.start();
    await quote(last);
    await settle(10);
    expect(master.listPositions()).toHaveLength(50);
    expect(followers[0]!.listPositions()).toHaveLength(50);
    // $5 opens 8 positions of 0.01, the burst its own balance calls for.
    expect(followers[1]!.listPositions()).toHaveLength(8);
    expect(followers[1]!.listPositions().every((p) => p.volume === 0.01 && p.origin === 'copy')).toBe(true);
    // The same take-profit price on every account.
    const tps = new Set([...master.listPositions(), ...followers.flatMap((f) => f.listPositions())].map((p) => p.takeProfit));
    expect(tps.size).toBe(1);
  });

  it('does not hammer the broker when a burst is refused', async () => {
    const { runtime, master, quote, last } = setup({ balance: 10, drift: 0.05 });
    const submit = master.submit.bind(master);
    let calls = 0;
    master.submit = async (req) => {
      calls += 1;
      return { ok: false, error: 'market closed', code: 'TRADE_RETCODE_MARKET_CLOSED' };
    };
    runtime.bot.start();
    await quote(last);
    expect(calls).toBe(16);
    await quote(last + 0.1);
    await quote(last + 0.2);
    expect(calls).toBe(16);
    master.submit = submit;
    for (let i = 0; i < 5; i += 1) await quote(last + 0.3);
    expect(master.listPositions()).toHaveLength(16);
  });
});
