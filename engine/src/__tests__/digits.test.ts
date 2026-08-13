import { describe, expect, it } from 'vitest';
import {
  breakEvenPayout,
  expectedValue,
  fairWinChance,
  lastDigit,
  readUniformity,
  tallyDigits,
  uniformityChiSquared,
  zScore,
} from '@sentinal/shared';

/**
 * These hold the digit maths to what is actually true of a random generator.
 * The point of the module is that it measures and never forecasts, so the
 * tests check the measurements are right and that the payout arithmetic tells
 * the truth about the edge.
 */

function digitsOf(text: string): number[] {
  return [...text].map(Number);
}

describe('lastDigit', () => {
  it('reads the final decimal place at the symbol precision', () => {
    expect(lastDigit(1234.56, 2)).toBe(6);
    expect(lastDigit(1234.5, 2)).toBe(0);
    expect(lastDigit(9.874, 3)).toBe(4);
    expect(lastDigit(100, 0)).toBe(0);
  });

  it('survives the float that would otherwise round the wrong way', () => {
    // 1234.56 * 100 is 123455.99999999999 in binary floating point, so a
    // multiply-and-modulo reads 5 here instead of 6.
    expect(lastDigit(1234.56, 2)).toBe(6);
    expect(lastDigit(0.29, 2)).toBe(9);
    expect(lastDigit(8.615, 3)).toBe(5);
  });

  it('does not throw on nonsense', () => {
    expect(lastDigit(Number.NaN, 2)).toBe(0);
    expect(lastDigit(1.23, -1)).toBe(0);
  });
});

describe('tallyDigits', () => {
  it('counts, splits by parity, and finds the extremes', () => {
    const stats = tallyDigits(digitsOf('1234567890'));
    expect(stats.total).toBe(10);
    expect(stats.even).toBe(5);
    expect(stats.odd).toBe(5);
    expect(stats.counts.every((c) => c === 1)).toBe(true);
    expect(stats.last).toBe(0);
  });

  it('reports frequency as a share of the window', () => {
    const stats = tallyDigits(digitsOf('1111122222'));
    expect(stats.frequency[1]).toBeCloseTo(0.5);
    expect(stats.frequency[2]).toBeCloseTo(0.5);
    expect(stats.frequency[3]).toBe(0);
    expect(stats.hottest).toBe(1);
  });

  it('measures the parity run at the end of the window, not anywhere in it', () => {
    // Ends 4, 6, 8 — three evens, despite a longer even run earlier.
    expect(tallyDigits(digitsOf('2222_1468'.replace('_', ''))).parityStreak).toBe(3);
    expect(tallyDigits(digitsOf('1357')).parityStreak).toBe(4);
    expect(tallyDigits([]).parityStreak).toBe(0);
  });

  it('ignores anything that is not a digit', () => {
    const stats = tallyDigits([1, 2, 99, -3, 4.5, 7]);
    expect(stats.total).toBe(3);
  });
});

describe('contract odds', () => {
  it('knows what each contract needs to happen', () => {
    expect(fairWinChance('matches', 5)).toBeCloseTo(0.1);
    expect(fairWinChance('differs', 5)).toBeCloseTo(0.9);
    expect(fairWinChance('even', 0)).toBeCloseTo(0.5);
    expect(fairWinChance('odd', 0)).toBeCloseTo(0.5);
    // Over 5 wins on 6,7,8,9 — four of ten.
    expect(fairWinChance('over', 5)).toBeCloseTo(0.4);
    // Under 5 wins on 0,1,2,3,4 — five of ten.
    expect(fairWinChance('under', 5)).toBeCloseTo(0.5);
    // The extremes cannot win.
    expect(fairWinChance('over', 9)).toBeCloseTo(0);
    expect(fairWinChance('under', 0)).toBeCloseTo(0);
  });

  it('states the payout that would make a contract fair', () => {
    expect(breakEvenPayout('matches', 3)).toBeCloseTo(10);
    expect(breakEvenPayout('even', 0)).toBeCloseTo(2);
    expect(breakEvenPayout('over', 5)).toBeCloseTo(2.5);
  });

  it('prices the house edge honestly', () => {
    // Deriv pays well under the fair multiple, so the expectation is negative.
    expect(expectedValue('matches', 3, 9)).toBeCloseTo(-0.1);
    expect(expectedValue('even', 0, 1.95)).toBeCloseTo(-0.025);
    // Only a payout above break-even is positive, and Deriv does not offer one.
    expect(expectedValue('even', 0, 2)).toBeCloseTo(0);
    expect(expectedValue('even', 0, 2.1)).toBeGreaterThan(0);
  });
});

describe('uniformity', () => {
  it('calls a flat window consistent with chance', () => {
    const flat = tallyDigits(Array.from({ length: 500 }, (_, i) => i % 10));
    expect(uniformityChiSquared(flat)).toBeCloseTo(0);
    expect(readUniformity(flat)).toBe('consistent');
  });

  it('refuses to judge a window too small to judge', () => {
    expect(readUniformity(tallyDigits(digitsOf('1234')))).toBe('insufficient');
  });

  it('flags a window that really is skewed', () => {
    // Every tick a 7: as far from uniform as a window can be.
    const skewed = tallyDigits(new Array(200).fill(7));
    expect(uniformityChiSquared(skewed)).toBeGreaterThan(21.67);
    expect(readUniformity(skewed)).toBe('very-unusual');
  });

  it('scores a departure in standard deviations', () => {
    // 60 evens in 100 draws is two standard deviations above the mean of 50.
    expect(zScore(60, 100, 0.5)).toBeCloseTo(2);
    expect(zScore(50, 100, 0.5)).toBeCloseTo(0);
    expect(zScore(0, 0, 0.5)).toBe(0);
  });
});
