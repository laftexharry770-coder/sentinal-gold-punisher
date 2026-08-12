import { afterEach, describe, expect, it } from 'vitest';
import {
  XAUUSD,
  getSymbolSpec,
  grossProfit,
  marginRequired,
  registerSymbolSpec,
  roundLot,
  stopLevels,
  usdToPriceDistance,
  type SymbolSpec,
} from '@sentinal/shared';

/**
 * Brokers quote gold on their own terms: a different symbol name, a different
 * contract size, a coarser lot grid. Once a specification is registered the
 * engine must price against it, not against the built-in default.
 */
const MICRO_GOLD: SymbolSpec = {
  symbol: 'GOLD.m',
  digits: 3,
  tickSize: 0.001,
  contractSize: 10, // 10 oz per lot instead of 100
  minLot: 0.1,
  maxLot: 20,
  lotStep: 0.1,
  baseSpread: 0.3,
  commissionPerLot: 4,
};

afterEach(() => {
  // Keep the default spec intact for the other suites.
  registerSymbolSpec(XAUUSD);
});

describe('broker-supplied contract specifications', () => {
  it('is used instead of the built-in default once registered', () => {
    expect(getSymbolSpec('GOLD.m')).toBe(XAUUSD);
    registerSymbolSpec(MICRO_GOLD);
    expect(getSymbolSpec('GOLD.m').contractSize).toBe(10);
  });

  it('prices profit on the broker contract size', () => {
    registerSymbolSpec(MICRO_GOLD);
    const spec = getSymbolSpec('GOLD.m');
    // A $1 move on 1 lot of a 10 oz contract is $10, not $100.
    expect(grossProfit(spec, 'buy', 1, 3300, 3301)).toBeCloseTo(10, 6);
    expect(grossProfit(XAUUSD, 'buy', 1, 3300, 3301)).toBeCloseTo(100, 6);
  });

  it('converts money targets into the right price distance', () => {
    registerSymbolSpec(MICRO_GOLD);
    const spec = getSymbolSpec('GOLD.m');
    // $2 on 0.1 lots of a 10 oz contract needs a $2 move.
    expect(usdToPriceDistance(spec, 0.1, 2)).toBeCloseTo(2, 6);
    expect(usdToPriceDistance(XAUUSD, 0.1, 2)).toBeCloseTo(0.2, 6);
  });

  it('places stops and targets at the broker digits', () => {
    registerSymbolSpec(MICRO_GOLD);
    const spec = getSymbolSpec('GOLD.m');
    const levels = stopLevels(spec, 'buy', 0.1, 3300, 2, 1);
    expect(levels.stopLoss).toBe(3298);
    expect(levels.takeProfit).toBe(3301);
  });

  it('honours a coarser lot grid', () => {
    registerSymbolSpec(MICRO_GOLD);
    const spec = getSymbolSpec('GOLD.m');
    expect(roundLot(spec, 0.14)).toBe(0.1);
    expect(roundLot(spec, 0.16)).toBe(0.2);
    // Below the broker minimum clamps up rather than sending a rejected order.
    expect(roundLot(spec, 0.01)).toBe(0.1);
  });

  it('sizes margin from the broker contract, not the default', () => {
    registerSymbolSpec(MICRO_GOLD);
    const spec = getSymbolSpec('GOLD.m');
    expect(marginRequired(spec, 1, 3300, 500)).toBeCloseTo(66, 6);
    expect(marginRequired(XAUUSD, 1, 3300, 500)).toBeCloseTo(660, 6);
  });
});
