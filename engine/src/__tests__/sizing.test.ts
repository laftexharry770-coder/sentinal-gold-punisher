import { describe, expect, it } from 'vitest';
import { XAUUSD, riskSizedLeg, type SymbolSpec } from '@sentinal/shared';
import { AccountManager } from '../broker/manager.js';
import { BotEngine } from '../engine/bot.js';
import { Journal } from '../journal.js';

function harness(balance: number) {
  const journal = new Journal();
  const accounts = new AccountManager();
  const bot = new BotEngine(accounts, journal);
  const account = accounts.add({
    name: 'Sized',
    login: '1',
    server: 'test',
    role: 'master',
    initialBalance: balance,
  });
  accounts.onTick({ symbol: 'XAUUSD', bid: 3300, ask: 3300.2, time: Date.now() });
  return { bot, account, journal };
}

describe('risk-based position sizing', () => {
  it('risks the configured share of equity', () => {
    // 1% of 10,000 is 100; a $2 stop on 100 oz per lot is $200 per lot.
    const sized = riskSizedLeg(XAUUSD, 10_000, 1, 2, 0.5);
    expect(sized.volume).toBeCloseTo(0.5, 6);
    expect(sized.riskUsd).toBeCloseTo(100, 6);
    expect(sized.stopLossUsd).toBeCloseTo(100, 6);
    expect(sized.takeProfitUsd).toBeCloseTo(50, 6);
    expect(sized.minLotExceedsRisk).toBe(false);
  });

  it('scales with the account rather than staying fixed', () => {
    const small = riskSizedLeg(XAUUSD, 1_000, 1, 2, 0.5);
    const large = riskSizedLeg(XAUUSD, 100_000, 1, 2, 0.5);
    expect(large.volume).toBeCloseTo(small.volume * 100, 4);
    expect(large.riskUsd).toBeCloseTo(small.riskUsd * 100, 4);
  });

  it('reports when the broker minimum forces more risk than asked', () => {
    // 0.25% of 200 is $0.50, but 0.01 lots risks $2 at a $2 stop.
    const sized = riskSizedLeg(XAUUSD, 200, 0.25, 2, 0.5);
    expect(sized.volume).toBe(XAUUSD.minLot);
    expect(sized.minLotExceedsRisk).toBe(true);
    expect(sized.riskUsd).toBeCloseTo(2, 6);
  });

  it('sizes on the broker lot grid, not a finer one', () => {
    const coarse: SymbolSpec = { ...XAUUSD, symbol: 'GOLD.coarse', minLot: 0.1, lotStep: 0.1 };
    const sized = riskSizedLeg(coarse, 10_000, 1, 2, 0.5);
    // 0.5 lots exactly on this grid; risk is what the rounded volume implies.
    expect(sized.volume).toBeCloseTo(0.5, 6);
    expect((sized.volume / coarse.lotStep) % 1).toBeCloseTo(0, 6);
  });

  it('keeps the stop-to-target ratio the operator set', () => {
    const sized = riskSizedLeg(XAUUSD, 10_000, 1, 2, 2);
    expect(sized.takeProfitUsd).toBeCloseTo(sized.stopLossUsd * 2, 6);
  });

  it('is used by the engine, sized from live equity', () => {
    const { bot, account } = harness(20_000);
    bot.updateConfig({ sizing: 'risk-percent', riskPercent: 1, stopDistance: 2, rewardRatio: 0.5 });

    const first = bot.sizeLeg(account);
    expect(first.volume).toBeCloseTo(1, 6);
    expect(first.stopLossUsd).toBeCloseTo(200, 6);

    // Halve the account and the next leg is half the size.
    account.syncBalance(10_000);
    expect(bot.sizeLeg(account).volume).toBeCloseTo(0.5, 6);
  });

  it('falls back to the fixed lot when sizing is fixed', () => {
    const { bot, account } = harness(20_000);
    bot.updateConfig({ sizing: 'fixed', lotSize: 0.03, stopLossUsd: 2, takeProfitUsd: 1 });
    expect(bot.sizeLeg(account)).toEqual({ volume: 0.03, stopLossUsd: 2, takeProfitUsd: 1 });
  });
});
