import { describe, expect, it } from 'vitest';
import { DEFAULT_COPY_SETTINGS, type Tick } from '@sentinal/shared';
import { TradingAccount } from '../broker/account.js';

function makeAccount(balance = 10_000): TradingAccount {
  return new TradingAccount({
    id: 'acc_test',
    name: 'Test',
    provider: 'sim',
    login: '1',
    server: 'test',
    broker: 'test',
    currency: 'USD',
    leverage: 500,
    role: 'standalone',
    initialBalance: balance,
    copy: { ...DEFAULT_COPY_SETTINGS },
  });
}

function tick(bid: number, time = Date.now()): Tick {
  return { symbol: 'XAUUSD', bid, ask: bid + 0.2, time };
}

describe('TradingAccount', () => {
  it('rejects orders before a quote has arrived', () => {
    const account = makeAccount();
    const result = account.open({ symbol: 'XAUUSD', side: 'buy', volume: 0.01, origin: 'manual' });
    expect(result.ok).toBe(false);
  });

  it('fills a buy at the ask and prices it at the bid', () => {
    const account = makeAccount();
    account.onTick(tick(3300));
    const result = account.open({ symbol: 'XAUUSD', side: 'buy', volume: 0.01, origin: 'manual' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.position.openPrice).toBe(3300.2);
    expect(result.position.currentPrice).toBe(3300);
    // Spread cost plus commission is carried immediately.
    expect(result.position.profit).toBeLessThan(0);
  });

  it('holds several legs at once and reports them independently', () => {
    const account = makeAccount();
    account.onTick(tick(3300));
    for (let i = 0; i < 5; i += 1) {
      account.open({ symbol: 'XAUUSD', side: 'buy', volume: 0.01, origin: 'bot', basketIndex: i });
    }
    expect(account.listPositions()).toHaveLength(5);
    expect(new Set(account.listPositions().map((p) => p.ticket)).size).toBe(5);
  });

  it('closes a leg when its money-based target is touched', () => {
    const account = makeAccount();
    account.onTick(tick(3300));
    const opened = account.open({
      symbol: 'XAUUSD',
      side: 'buy',
      volume: 0.01,
      stopLossUsd: 2,
      takeProfitUsd: 1,
      origin: 'bot',
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect(opened.position.takeProfit).toBe(3301.2);

    account.onTick(tick(3301.5));
    expect(account.listPositions()).toHaveLength(0);
    const trade = account.history[0];
    expect(trade?.reason).toBe('tp');
    expect(trade?.profit).toBeCloseTo(1, 2);
  });

  it('closes a leg when its stop is touched and books the loss', () => {
    const account = makeAccount();
    account.onTick(tick(3300));
    account.open({ symbol: 'XAUUSD', side: 'sell', volume: 0.01, stopLossUsd: 2, takeProfitUsd: 1, origin: 'bot' });

    account.onTick(tick(3302.5));
    const trade = account.history[0];
    expect(trade?.reason).toBe('sl');
    expect(trade?.netProfit).toBeLessThan(0);
    expect(account.balance).toBeLessThan(10_000);
  });

  it('refuses a position it cannot margin', () => {
    const account = makeAccount(50);
    account.onTick(tick(3300));
    const result = account.open({ symbol: 'XAUUSD', side: 'buy', volume: 5, origin: 'manual' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/free margin/);
  });

  it('closes only the legs matching a filter', () => {
    const account = makeAccount();
    account.onTick(tick(3300));
    account.open({ symbol: 'XAUUSD', side: 'buy', volume: 0.01, origin: 'bot' });
    account.open({ symbol: 'XAUUSD', side: 'sell', volume: 0.01, origin: 'bot' });
    account.open({ symbol: 'XAUUSD', side: 'buy', volume: 0.01, origin: 'manual' });

    account.closeAll('manual', (p) => p.side === 'buy');
    expect(account.listPositions()).toHaveLength(1);
    expect(account.listPositions()[0]?.side).toBe('sell');
  });
});
