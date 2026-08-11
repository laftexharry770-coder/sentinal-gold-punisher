import { describe, expect, it } from 'vitest';
import {
  XAUUSD,
  grossProfit,
  marginRequired,
  roundLot,
  stopLevels,
  usdToPriceDistance,
} from '@sentinal/shared';

describe('XAUUSD money math', () => {
  it('converts a dollar target into a price distance for the traded volume', () => {
    // 0.01 lots = 1 oz, so $1 of profit is exactly a $1 move in gold.
    expect(usdToPriceDistance(XAUUSD, 0.01, 1)).toBeCloseTo(1, 6);
    expect(usdToPriceDistance(XAUUSD, 0.1, 1)).toBeCloseTo(0.1, 6);
    expect(usdToPriceDistance(XAUUSD, 1, 100)).toBeCloseTo(1, 6);
  });

  it('places the spec stop and target either side of the entry', () => {
    const long = stopLevels(XAUUSD, 'buy', 0.01, 3300, 2, 1);
    expect(long.stopLoss).toBe(3298);
    expect(long.takeProfit).toBe(3301);

    const short = stopLevels(XAUUSD, 'sell', 0.01, 3300, 2, 1);
    expect(short.stopLoss).toBe(3302);
    expect(short.takeProfit).toBe(3299);
  });

  it('prices profit symmetrically for both directions', () => {
    expect(grossProfit(XAUUSD, 'buy', 0.01, 3300, 3301)).toBeCloseTo(1, 6);
    expect(grossProfit(XAUUSD, 'sell', 0.01, 3300, 3299)).toBeCloseTo(1, 6);
    expect(grossProfit(XAUUSD, 'buy', 0.05, 3300, 3298)).toBeCloseTo(-10, 6);
  });

  it('clamps volume to the broker lot grid', () => {
    expect(roundLot(XAUUSD, 0.014)).toBe(0.01);
    expect(roundLot(XAUUSD, 0.016)).toBe(0.02);
    expect(roundLot(XAUUSD, 0.0001)).toBe(0.01);
    expect(roundLot(XAUUSD, 999)).toBe(XAUUSD.maxLot);
  });

  it('sizes margin from notional and leverage', () => {
    expect(marginRequired(XAUUSD, 0.01, 3300, 500)).toBeCloseTo(6.6, 6);
  });
});
