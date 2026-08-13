import { describe, expect, it } from 'vitest';
import { grossProfit, type SymbolSpec } from '@sentinal/shared';
import {
  CONTRACT_SIZE,
  goldCandidates,
  isDemoAccountId,
  isValidAppId,
  stakeFor,
  tokenShapeWarning,
  volumeFor,
} from '../derivClient';

/**
 * Deriv stakes money; the engine sizes lots. The two only agree if the
 * conversion is exact, so these tests hold it to the one thing that matters:
 * a lot on this terminal must earn what the same lot would earn on MetaTrader,
 * and Deriv's own contract must pay exactly that.
 */

const SPEC: SymbolSpec = {
  symbol: 'frxXAUUSD',
  digits: 2,
  tickSize: 0.01,
  contractSize: CONTRACT_SIZE,
  minLot: 0.01,
  maxLot: 100,
  lotStep: 0.01,
  baseSpread: 0,
  commissionPerLot: 0,
};

/** What Deriv actually pays a multiplier contract. */
function derivProfit(stake: number, multiplier: number, entry: number, exit: number, long: boolean): number {
  const move = long ? exit - entry : entry - exit;
  return stake * multiplier * (move / entry);
}

describe('Deriv stake conversion', () => {
  it('stakes what a lot is worth at the current price', () => {
    // 0.01 lots of gold is 1 oz; at 3300 that is 3300 of exposure, which a
    // 100x multiplier reaches with a 33 stake.
    expect(stakeFor(0.01, 3300, 100)).toBe(33);
    expect(stakeFor(0.1, 3300, 100)).toBe(330);
    // A bigger multiplier reaches the same exposure with less money down.
    expect(stakeFor(0.01, 3300, 200)).toBe(16.5);
  });

  it('round-trips a stake back to the lots it represents', () => {
    for (const [volume, price, multiplier] of [
      [0.01, 3300, 100],
      [0.25, 2412.55, 40],
      [1.5, 4100.9, 200],
    ] as const) {
      const stake = stakeFor(volume, price, multiplier);
      expect(volumeFor(stake, price, multiplier)).toBeCloseTo(volume, 3);
    }
  });

  it('pays the same money as the engine expects from the lot', () => {
    const entry = 3300;
    const multiplier = 100;

    for (const [volume, exit, long] of [
      [0.01, 3312, true],
      [0.05, 3288.5, true],
      [0.2, 3271.25, false],
      [1, 3355.75, false],
    ] as const) {
      const stake = stakeFor(volume, entry, multiplier);
      const engine = grossProfit(SPEC, long ? 'buy' : 'sell', volume, entry, exit);
      const deriv = derivProfit(stake, multiplier, entry, exit, long);
      // Stakes are quoted to the cent, so the two agree to within that rounding.
      expect(deriv).toBeCloseTo(engine, 1);
    }
  });

  it('refuses to invent a stake without a price or a multiplier', () => {
    expect(stakeFor(0.1, 0, 100)).toBe(0);
    expect(stakeFor(0.1, 3300, 0)).toBe(0);
    expect(volumeFor(50, 0, 100)).toBe(0);
  });
});

describe('app id validation', () => {
  it('accepts both shapes Deriv issues', () => {
    expect(isValidAppId('1089')).toBe(true);
    expect(isValidAppId(' 36300 ')).toBe(true);
    // developers.deriv.com issues alphanumeric app ids. An earlier numeric-only
    // rule here rejected a real registration, so this pins the correction.
    expect(isValidAppId('346nAVo5UnAYrR28llELJ')).toBe(true);
  });

  it('rejects only what cannot survive a URL', () => {
    expect(isValidAppId('app id')).toBe(false);
    expect(isValidAppId('108.9')).toBe(false);
    expect(isValidAppId('a/b')).toBe(false);
    expect(isValidAppId('')).toBe(false);
  });
});

describe('account id kind', () => {
  it("reads Deriv's own prefixes", () => {
    // Taken from real accounts: DOT is demo, ROT is real.
    expect(isDemoAccountId('DOT93898941')).toBe(true);
    expect(isDemoAccountId('ROT92291419')).toBe(false);
    // The older accounts use VRTC and CR.
    expect(isDemoAccountId('VRTC1234567')).toBe(true);
    expect(isDemoAccountId('CR1234567')).toBe(false);
    expect(isDemoAccountId(' dot93898941 ')).toBe(true);
  });

  it('calls an unfamiliar prefix real, which is the safe way to be wrong', () => {
    // This label sits beside a live-trading switch, so an unknown id must not
    // read as practice money.
    expect(isDemoAccountId('XYZ123')).toBe(false);
    expect(isDemoAccountId('')).toBe(false);
  });
});

describe('token shape', () => {
  it('passes tokens of any length, since Deriv owns that format', () => {
    // Deliberately not length-checked: a rule guessed here could lock someone
    // out of a token that works.
    expect(tokenShapeWarning('a1b2c3d4e5f6g7h')).toBeNull();
    expect(tokenShapeWarning('346nAVo5UnAYrR28llELJ')).toBeNull();
    expect(tokenShapeWarning('  padded-token_9  ')).toBeNull();
    expect(tokenShapeWarning('')).toBeNull();
  });

  it('flags a copy that plainly went wrong', () => {
    expect(tokenShapeWarning('abc def')).toMatch(/space or line break/);
    expect(tokenShapeWarning('abc\ndef')).toMatch(/space or line break/);
    expect(tokenShapeWarning('token: abc')).toMatch(/space or line break/);
    expect(tokenShapeWarning('"abc123"')).toMatch(/punctuation/);
  });

  it('judges no length, because Deriv issues more than one', () => {
    // A length rule here rejected a real token once already. The field prints
    // its character count instead, and Deriv decides.
    expect(tokenShapeWarning('a1b2c3d4e5f6g7h')).toBeNull();
    expect(tokenShapeWarning('a'.repeat(68))).toBeNull();
    expect(tokenShapeWarning('a'.repeat(120))).toBeNull();
  });
});

describe('gold symbol discovery', () => {
  it('picks out the gold instruments Deriv lists', () => {
    const candidates = goldCandidates([
      { symbol: 'frxXAUUSD', displayName: 'Gold/USD', pip: 0.01, market: 'commodities', open: true },
      { symbol: 'frxEURUSD', displayName: 'EUR/USD', pip: 0.00001, market: 'forex', open: true },
      { symbol: 'frxXAGUSD', displayName: 'Silver/USD', pip: 0.001, market: 'commodities', open: true },
      { symbol: 'R_100', displayName: 'Volatility 100 Index', pip: 0.01, market: 'synthetic', open: true },
    ]);
    expect(candidates).toEqual(['frxXAUUSD']);
  });
});
