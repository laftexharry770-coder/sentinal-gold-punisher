import { describe, expect, it } from 'vitest';
import {
  DEFAULT_BOT_CONFIG,
  XAUUSD,
  priceDistanceToUsd,
  usdToPriceDistance,
  type BotConfig,
  type ClosedTrade,
  type Signal,
} from '@sentinal/shared';
import { RecoveryEngine } from '../engine/recovery.js';

const config: BotConfig = {
  ...DEFAULT_BOT_CONFIG,
  zeroLoss: { ...DEFAULT_BOT_CONFIG.zeroLoss },
};

function loss(amount: number, layer = 0): ClosedTrade {
  return {
    id: `t_${amount}_${layer}`,
    ticket: 1,
    accountId: 'acc',
    symbol: 'XAUUSD',
    side: 'buy',
    volume: 0.01,
    openPrice: 3300,
    closePrice: 3298,
    openTime: 0,
    closeTime: 1,
    profit: -amount,
    commission: 0,
    swap: 0,
    netProfit: -amount,
    reason: 'sl',
    origin: layer > 0 ? 'recovery' : 'bot',
    recoveryLayer: layer,
    comment: '',
  };
}

function win(amount: number): ClosedTrade {
  return { ...loss(0), id: `w_${amount}`, profit: amount, netProfit: amount, reason: 'tp' };
}

const signal: Signal = {
  time: 1,
  symbol: 'XAUUSD',
  side: 'buy',
  strength: 0.8,
  fast: 3300,
  slow: 3299,
  momentum: 0.4,
  volatility: 0.1,
  reason: 'test',
};

describe('Zero-loss recovery', () => {
  it('stays idle while there is no deficit', () => {
    const engine = new RecoveryEngine();
    expect(engine.plan('acc', config, signal)).toBeNull();
    expect(engine.pendingDeficit).toBe(0);
  });

  it('postpones the recovery until a signal agrees with its direction', () => {
    const engine = new RecoveryEngine();
    engine.registerLoss(loss(2));
    const plan = engine.plan('acc', config, null);
    expect(plan).toBeNull();
    const pending = engine.list()[0];
    expect(pending?.status).toBe('pending');
    expect(pending?.holdReason).toMatch(/aligned signal/);
  });

  it('sizes the recovery so its target clears the deficit plus the profit floor', () => {
    const engine = new RecoveryEngine();
    engine.registerLoss(loss(4));

    const plan = engine.plan('acc', config, signal);
    expect(plan).not.toBeNull();
    if (!plan) return;

    const distance = usdToPriceDistance(XAUUSD, config.lotSize, config.takeProfitUsd);
    const gross = priceDistanceToUsd(XAUUSD, plan.legVolume * plan.legs, distance);
    expect(gross).toBeGreaterThan(4 + config.zeroLoss.minNetProfitUsd);
    expect(plan.projectedNet).toBeGreaterThanOrEqual(config.zeroLoss.minNetProfitUsd);
    expect(plan.side).toBe('buy');
  });

  it('splits an oversized recovery across several simultaneous legs', () => {
    const engine = new RecoveryEngine();
    engine.registerLoss(loss(30));

    const capped: BotConfig = {
      ...config,
      zeroLoss: { ...config.zeroLoss, maxRecoveryLot: 0.1, maxRecoveryLayers: 6 },
    };
    const plan = engine.plan('acc', capped, signal);
    expect(plan).not.toBeNull();
    if (!plan) return;

    expect(plan.legs).toBeGreaterThan(1);
    expect(plan.legVolume).toBeLessThanOrEqual(0.1);
    expect(plan.projectedNet).toBeGreaterThanOrEqual(capped.zeroLoss.minNetProfitUsd);
  });

  it('holds when the required size cannot be reached within the layer budget', () => {
    const engine = new RecoveryEngine();
    engine.registerLoss(loss(60));

    const tight: BotConfig = {
      ...config,
      zeroLoss: { ...config.zeroLoss, maxRecoveryLot: 0.05, maxRecoveryLayers: 2 },
    };
    expect(engine.plan('acc', tight, signal)).toBeNull();
    expect(engine.list()[0]?.holdReason).toMatch(/above the/);
  });

  it('refuses to fire while the layer budget is exhausted', () => {
    const engine = new RecoveryEngine();
    engine.registerLoss(loss(1, 3));
    const limited: BotConfig = { ...config, zeroLoss: { ...config.zeroLoss, maxRecoveryLayers: 4 } };
    expect(engine.plan('acc', limited, signal)).toBeNull();
    expect(engine.list()[0]?.holdReason).toMatch(/max recovery layers/);
  });

  it('clears the deficit and resets the layer once a recovery pays out', () => {
    const engine = new RecoveryEngine();
    engine.registerLoss(loss(3));
    const plan = engine.plan('acc', config, signal);
    expect(plan).not.toBeNull();
    if (plan) engine.markFired(plan);
    expect(engine.currentLayer).toBe(1);

    engine.registerGain(win(1));
    expect(engine.pendingDeficit).toBeCloseTo(2, 2);

    const cleared = engine.registerGain(win(2));
    expect(cleared).toBe(true);
    expect(engine.pendingDeficit).toBe(0);
    expect(engine.currentLayer).toBe(0);
  });

  it('does nothing when zero-loss is switched off', () => {
    const engine = new RecoveryEngine();
    engine.registerLoss(loss(5));
    const off: BotConfig = { ...config, zeroLoss: { ...config.zeroLoss, enabled: false } };
    expect(engine.plan('acc', off, signal)).toBeNull();
    expect(engine.list()).toHaveLength(0);
  });
});
