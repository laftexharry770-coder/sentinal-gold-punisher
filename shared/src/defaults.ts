import type { BotConfig, CopySettings } from './types.js';

/**
 * Handoff spec defaults: XAUUSD only, 0.01 lots, $2.00 stop / $1.00 target,
 * intrabar execution and zero-loss postponement enabled.
 * Multi-position execution is on by default — 8 concurrent legs, 2 fired per signal.
 */
export const DEFAULT_BOT_CONFIG: BotConfig = {
  enabled: false,
  symbol: 'XAUUSD',
  execution: 'intrabar',
  strategy: 'adaptive-scalp',
  lotSize: 0.01,
  stopLossUsd: 2.0,
  takeProfitUsd: 1.0,

  maxConcurrentPositions: 8,
  maxPositionsPerDirection: 5,
  entriesPerSignal: 2,
  entrySpacingUsd: 0.35,
  allowHedging: true,
  signalCooldownMs: 4000,
  minSignalStrength: 0.35,

  basketTakeProfitUsd: 6,
  basketStopLossUsd: null,

  maxSpread: 0.6,
  maxDailyLossUsd: 60,
  maxDailyTrades: 400,

  zeroLoss: {
    enabled: true,
    recoveryMultiplier: 1.15,
    maxRecoveryLayers: 4,
    minNetProfitUsd: 0.25,
    maxDeficitUsd: 40,
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
