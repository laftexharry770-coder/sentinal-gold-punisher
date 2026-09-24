import type { Side } from './types.js';

/**
 * The AI's vocabulary, shared by the engine that runs it and the terminal
 * that shows it.
 *
 * The AI does not know the future. It measures the market on every quote,
 * scores it with a panel of experts, weighs those experts by how right each
 * has been lately in the current kind of market, and calibrates the result
 * into a probability — learning from every closed bar and every closed trade.
 */

/** The kind of market the AI believes it is in; each has its own expert weights. */
export type AiRegime = 'trend-up' | 'trend-down' | 'range' | 'volatile' | 'quiet';

export const AI_REGIMES: readonly AiRegime[] = ['trend-up', 'trend-down', 'range', 'volatile', 'quiet'];

export const AI_REGIME_LABELS: Record<AiRegime, string> = {
  'trend-up': 'Trending up',
  'trend-down': 'Trending down',
  range: 'Ranging',
  volatile: 'Volatile',
  quiet: 'Quiet',
};

/** One member of the expert panel. */
export type AiExpertName = 'trend' | 'momentum' | 'breakout' | 'reversion' | 'squeeze' | 'flow' | 'candles' | 'session';

export const AI_EXPERTS: readonly { name: AiExpertName; label: string; reads: string }[] = [
  { name: 'trend', label: 'Trend', reads: 'EMA 9/21 on M1 and EMA 8/21 on M5' },
  { name: 'momentum', label: 'Momentum', reads: '10-bar rate of change and RSI 14' },
  { name: 'breakout', label: 'Breakout', reads: 'closes beyond the 20-bar high or low' },
  { name: 'reversion', label: 'Mean reversion', reads: 'Bollinger %B and RSI extremes, faded' },
  { name: 'squeeze', label: 'Squeeze', reads: 'Bollinger width expanding out of a squeeze' },
  { name: 'flow', label: 'Order flow', reads: 'upticks against downticks in the last minute' },
  { name: 'candles', label: 'Price action', reads: 'bodies and rejection wicks of the last bars' },
  { name: 'session', label: 'Session', reads: 'the drift this hour of day has shown' },
];

/** Claude's periodic review of the AI (needs an Anthropic API key). */
export interface AiClaudeConfig {
  enabled: boolean;
  /** Anthropic model id. */
  model: string;
  /** Minutes between reviews while the AI trades (0 = only after trades or on request). */
  intervalMin: number;
  /** Also review after this many AI trades have closed since the last review (0 = off). */
  afterTrades: number;
  /** Apply the suggested settings at once; off shows them for approval only. */
  autoApply: boolean;
}

export interface AiConfig {
  /** Trade only when the calibrated chance of the move is at least this (0.5–0.95). */
  minProbability: number;
  /** Share of equity risked by each AI trade at its stop. */
  riskPercent: number;
  /** Ceiling on riskPercent that no automatic adjustment may exceed. */
  maxRiskPercent: number;
  /** AI positions open at once (same direction, spaced one ATR apart). */
  maxPositions: number;
  /** Stop distance as a multiple of the 14-bar ATR, before the regime adjusts it. */
  slAtr: number;
  /** Reward-to-risk at the lowest confidence that trades … */
  rrMin: number;
  /** … and at full confidence. */
  rrMax: number;
  /** Move the stop to entry once the trade is this many ATR in profit (0 = off). */
  breakevenAtr: number;
  /** Start trailing once the trade is this many ATR in profit (0 = off). */
  trailStartAtr: number;
  /** Trailing distance, ATR. */
  trailAtr: number;
  /** Close a trade when the AI turns firmly against it. */
  exitOnFlip: boolean;
  /** Stop opening AI trades for the day once it has lost this share of the day's opening balance. */
  dailyLossPercent: number;
  /** Bars ahead each prediction is scored on (M1). */
  horizonBars: number;
  /** How fast expert weights move toward the experts that were right (0.05–1). */
  learningRate: number;
  /** Allow entries while the market reads as volatile. */
  tradeVolatile: boolean;
  /** Veto an EA's new entries when the market reads as dangerous. */
  guardEas: boolean;
  /** Danger level (0–1) at which the guard vetoes new entries. */
  guardDanger: number;
  /** Veto an entry when the AI gives the opposite direction at least this probability. */
  guardAgainst: number;
  claude: AiClaudeConfig;
}

export interface AiExpertView {
  name: AiExpertName;
  label: string;
  /** −1 (sell) … +1 (buy). */
  score: number;
  /** Share of the vote in the current regime, 0–1. */
  weight: number;
  /** How often this expert's direction was right (recent, confident calls), or null before enough calls. */
  hitRate: number | null;
}

export interface AiDanger {
  /** 0 calm … 1 dangerous. */
  level: number;
  reasons: string[];
}

export interface AiLearning {
  /** Bars the model has scored its predictions on. */
  samples: number;
  /** Share of predictions whose direction was right (recent). */
  accuracy: number | null;
  /** The same for predictions at or above the trading threshold. */
  confidentAccuracy: number | null;
  /** AI trades closed and learned from. */
  trades: number;
  winRate: number | null;
  /** Average result per trade in units of its initial risk (R). */
  expectancyR: number | null;
  /** When the model was last saved or loaded. */
  updatedAt: number | null;
}

export interface AiReading {
  ready: boolean;
  /** Why it is not ready yet (warming up on history). */
  warmup: string | null;
  time: number;
  regime: AiRegime;
  /** Calibrated chance that price is higher after the horizon, 0–1. */
  probabilityUp: number;
  /** Which way it leans, or null when it has no edge worth naming. */
  side: Side | null;
  /** |2p − 1|: 0 no idea … 1 certain. */
  confidence: number;
  /** Weighted vote of the experts, −1 … +1. */
  ensemble: number;
  experts: AiExpertView[];
  atr: number;
  adx: number;
  /** Kaufman efficiency: 0 noise … 1 straight line. */
  efficiency: number;
  /** Short-term volatility against its long-term level. */
  volatilityRatio: number;
  /** Spread against its recent average. */
  spreadRatio: number;
  danger: AiDanger;
  /** The strongest reasons behind the lean, in words. */
  reasons: string[];
  /** Probability the AI currently requires before it trades (adapts to its results). */
  threshold: number;
  learning: AiLearning;
}

export interface AiReview {
  id: string;
  time: number;
  model: string;
  /** Claude's assessment, in its words. */
  assessment: string;
  /** Settings it changed or suggested, in words. */
  changes: string[];
  applied: boolean;
  /** Why the review failed, when it did. */
  error: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
}

export interface AiStatus {
  reading: AiReading | null;
  reviews: AiReview[];
  claude: {
    /** An API key is available (in this browser, or on the server). */
    configured: boolean;
    busy: boolean;
    lastReviewAt: number | null;
    nextReviewAt: number | null;
  };
  /** Claude may pause the AI's entries for a while; null when not paused. */
  pausedUntil: number | null;
  /** A suggestion waiting for approval when auto-apply is off. */
  pending: AiReview | null;
  /** The guard over EAs: entries it has refused, and why the last one was. */
  guard: { vetoes: number; last: string | null; lastAt: number | null };
}

export const DEFAULT_AI_CONFIG: AiConfig = {
  minProbability: 0.6,
  riskPercent: 1,
  maxRiskPercent: 2,
  maxPositions: 1,
  slAtr: 1.5,
  rrMin: 1.5,
  rrMax: 3,
  breakevenAtr: 1,
  trailStartAtr: 1.5,
  trailAtr: 1,
  exitOnFlip: true,
  dailyLossPercent: 5,
  horizonBars: 5,
  learningRate: 0.3,
  tradeVolatile: false,
  guardEas: true,
  guardDanger: 0.7,
  guardAgainst: 0.72,
  claude: {
    enabled: false,
    model: 'claude-opus-5',
    intervalMin: 30,
    afterTrades: 10,
    autoApply: true,
  },
};
