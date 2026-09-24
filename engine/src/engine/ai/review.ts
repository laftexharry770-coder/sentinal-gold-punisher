import { AI_EXPERTS, type AiConfig, type AiExpertName, type AiReading, type AiRegime, type AiLearning, type Side } from '@sentinal/shared';

/** One closed AI trade, as the review sees it. */
export interface ReviewTrade {
  time: number;
  side: Side;
  regime: AiRegime;
  /** Probability the AI gave the trade at entry, when known. */
  probability: number | null;
  /** Result in units of the initial risk. */
  r: number;
  netProfit: number;
}

/** Everything a reviewer is shown: the AI's settings, its state, its results, the market. */
export interface ReviewInput {
  time: string;
  symbol: string;
  balance: number;
  equity: number;
  settings: Pick<AiConfig, 'minProbability' | 'riskPercent' | 'maxRiskPercent' | 'slAtr' | 'rrMin' | 'rrMax' | 'maxPositions' | 'tradeVolatile'>;
  reading: Pick<
    AiReading,
    'regime' | 'probabilityUp' | 'threshold' | 'atr' | 'adx' | 'efficiency' | 'volatilityRatio' | 'spreadRatio' | 'danger' | 'reasons'
  >;
  learning: AiLearning;
  experts: { name: AiExpertName; score: number; weight: number; hitRate: number | null }[];
  weights: Record<AiRegime, Record<AiExpertName, number>>;
  regimeResults: Record<AiRegime, { trades: number; expectancyR: number | null }>;
  recentTrades: ReviewTrade[];
  recentBars: { time: string; open: number; high: number; low: number; close: number }[];
  day: { profit: number; trades: number };
}

/** What a reviewer may change. Every field is optional: leave alone what is fine. */
export interface ReviewSuggestion {
  assessment: string;
  minProbability?: number;
  riskPercent?: number;
  slAtr?: number;
  rrMin?: number;
  rrMax?: number;
  maxPositions?: number;
  /** A reviewer may stop the AI trading volatile markets, never start it. */
  tradeVolatile?: boolean;
  expertBias?: { expert: AiExpertName; multiplier: number }[];
  /** Pause the AI's entries for this many minutes (0 = no pause). */
  pauseMinutes?: number;
}

export interface ReviewResult {
  suggestion: ReviewSuggestion;
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
}

/** Anything that can review the AI: Claude in production, a fake in tests. */
export interface AiReviewClient {
  review(input: ReviewInput, model: string): Promise<ReviewResult>;
}

export interface BoundedChanges {
  config: Partial<AiConfig>;
  expertBias: Partial<Record<AiExpertName, number>>;
  pauseMinutes: number;
  /** Each change in words, e.g. "minimum probability 60% → 64%". */
  describe: string[];
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const pct = (v: number) => `${(v * 100).toFixed(0)}%`;
const EXPERT_NAMES = new Set(AI_EXPERTS.map((e) => e.name));

/**
 * A reviewer's suggestion, held inside the operator's limits. It can make the
 * AI pickier, smaller or slower, and re-weight its experts by up to half; it
 * can never raise risk above the operator's cap, open more positions than the
 * operator allows, or start trading volatile markets.
 */
export function boundSuggestion(s: ReviewSuggestion, current: AiConfig): BoundedChanges {
  const config: Partial<AiConfig> = {};
  const describe: string[] = [];
  const change = <K extends keyof AiConfig>(key: K, next: AiConfig[K], label: string, show: (v: AiConfig[K]) => string) => {
    if (next === current[key]) return;
    config[key] = next;
    describe.push(`${label} ${show(current[key])} → ${show(next)}`);
  };
  if (finite(s.minProbability)) {
    change('minProbability', Math.round(clamp(s.minProbability, 0.52, 0.9) * 100) / 100, 'minimum probability', (v) => pct(v as number));
  }
  if (finite(s.riskPercent)) {
    const riskCeiling = Math.min(current.maxRiskPercent, Math.max(current.riskPercent, 0.1) * 2);
    change('riskPercent', Math.round(clamp(s.riskPercent, 0.1, riskCeiling) * 100) / 100, 'risk per trade', (v) => `${v}%`);
  }
  if (finite(s.slAtr)) change('slAtr', Math.round(clamp(s.slAtr, 0.8, 3) * 100) / 100, 'stop', (v) => `${v} ATR`);
  const rrMin = finite(s.rrMin) ? Math.round(clamp(s.rrMin, 1, 3) * 100) / 100 : current.rrMin;
  if (rrMin !== current.rrMin) change('rrMin', rrMin, 'lowest target', (v) => `${v}R`);
  if (finite(s.rrMax)) change('rrMax', Math.round(clamp(s.rrMax, rrMin, 5) * 100) / 100, 'highest target', (v) => `${v}R`);
  else if (current.rrMax < rrMin) change('rrMax', rrMin, 'highest target', (v) => `${v}R`);
  if (finite(s.maxPositions)) {
    change('maxPositions', Math.round(clamp(s.maxPositions, 1, current.maxPositions)), 'positions at once', (v) => `${v}`);
  }
  if (s.tradeVolatile === false && current.tradeVolatile) change('tradeVolatile', false, 'trading volatile markets', (v) => (v ? 'on' : 'off'));

  const expertBias: Partial<Record<AiExpertName, number>> = {};
  for (const b of s.expertBias ?? []) {
    if (!b || !EXPERT_NAMES.has(b.expert) || !finite(b.multiplier)) continue;
    const m = Math.round(clamp(b.multiplier, 0.5, 1.5) * 100) / 100;
    if (m === 1) continue;
    expertBias[b.expert] = m;
    const label = AI_EXPERTS.find((e) => e.name === b.expert)?.label ?? b.expert;
    describe.push(`${label} expert's say ×${m}`);
  }
  const pauseMinutes = finite(s.pauseMinutes) ? Math.round(clamp(s.pauseMinutes, 0, 240)) : 0;
  if (pauseMinutes > 0) describe.push(`new AI entries paused for ${pauseMinutes} min`);
  return { config, expertBias, pauseMinutes, describe };
}
