import type { BotConfig, CopySettings } from './types.js';

/**
 * Handoff spec defaults: XAUUSD only, 0.01 lots, $2.00 stop / $1.00 target,
 * intrabar execution and zero-loss postponement enabled.
 *
 * Multi-position execution runs wide out of the box — 4 legs fired per signal,
 * up to 24 open together (12 per direction). At 0.01 lots that is 0.24 lots and
 * about $158 of margin at 1:500, with $48 of stops against $24 of targets, so
 * the daily guards below are sized for the fuller book.
 */
export const DEFAULT_BOT_CONFIG: BotConfig = {
  enabled: false,
  symbol: 'XAUUSD',
  execution: 'intrabar',
  strategy: 'adaptive-scalp',
  // Adaptive by default: each leg risks 0.25% of equity, with the stop a $2
  // move in gold and the target half of it, matching the shipped 2:1 profile.
  sizing: 'risk-percent',
  riskPercent: 0.25,
  stopDistance: 2.0,
  rewardRatio: 0.5,

  lotSize: 0.01,
  stopLossUsd: 2.0,
  takeProfitUsd: 1.0,

  maxConcurrentPositions: 24,
  maxPositionsPerDirection: 12,
  entriesPerSignal: 4,
  entrySpacingUsd: 0.15,
  allowHedging: true,
  signalCooldownMs: 1500,
  minSignalStrength: 0.35,

  basketTakeProfitUsd: 15,
  basketStopLossUsd: null,

  maxSpread: 0.6,
  maxDailyLossUsd: 150,
  maxDailyTrades: 1200,

  zeroLoss: {
    enabled: true,
    recoveryMultiplier: 1.15,
    maxRecoveryLayers: 4,
    minNetProfitUsd: 0.25,
    maxDeficitUsd: 80,
    requireSignalAlignment: true,
    maxRecoveryLot: 0.5,
  },
};

export const DEFAULT_COPY_SETTINGS: CopySettings = {
  enabled: false,
  masterId: null,
  sizing: 'multiplier',
  multiplier: 1,
  fixedLot: 0.01,
  reverse: false,
  copyStopLoss: true,
  copyTakeProfit: true,
  copyCloses: true,
  minLot: 0.01,
  maxLot: 5,
  maxSlippage: 0.5,
  symbolWhitelist: ['XAUUSD'],
};

export const TIMEFRAME_MS: Record<string, number> = {
  M1: 60_000,
  M5: 300_000,
  M15: 900_000,
  H1: 3_600_000,
};
