import { describe, expect, it } from 'vitest';
import { AI_EXPERTS, type AiReading } from '@sentinal/shared';
import { configureExpert, startBot } from '../commands.js';
import { eaInfo, loadEa } from './eaHelpers.js';
import { createRuntime } from '../runtime.js';

const settle = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

const EA = `
#include <Trade/Trade.mqh>
CTrade trade;
input int Mode = 0; // 0 = buy when flat, 1 = close everything
int OnInit() { return(INIT_SUCCEEDED); }
void OnTick()
  {
   if(Mode == 0 && PositionsTotal() == 0)
     {
      trade.Buy(0.01);
      Print("buy retcode ", trade.ResultRetcode(), " ", trade.ResultComment());
     }
   if(Mode == 1)
      for(int i = PositionsTotal() - 1; i >= 0; i--) trade.PositionClose(PositionGetTicket(i));
  }
`;

function reading(p: number, danger = 0): AiReading {
  return {
    ready: true,
    warmup: null,
    time: 0,
    regime: 'range',
    probabilityUp: p,
    side: p > 0.5 ? 'buy' : 'sell',
    confidence: Math.abs(2 * p - 1),
    ensemble: 0,
    experts: AI_EXPERTS.map((e) => ({ name: e.name, label: e.label, score: 0, weight: 1 / 8, hitRate: null })),
    atr: 1,
    adx: 20,
    efficiency: 0.2,
    volatilityRatio: danger > 0 ? 2.5 : 1,
    spreadRatio: 1,
    danger: { level: danger, reasons: danger > 0 ? ['volatility 2.5× its normal level'] : [] },
    reasons: [],
    threshold: 0.6,
    learning: { samples: 0, accuracy: null, confidentAccuracy: null, trades: 0, winRate: null, expectancyR: null, updatedAt: null },
  };
}

describe('the AI guard over EAs', () => {
  it('refuses an EA’s new entries in danger or against a firm call, and never its exits', async () => {
    const runtime = createRuntime({ seedPrice: 4300, tickIntervalMs: 1000, seed: 2, historyBars: 200 });
    const master = runtime.accounts.add({ name: 'Master', login: '1', server: 'sim', role: 'master', initialBalance: 10_000, leverage: 1000 });
    const added = await loadEa(runtime, [{ name: 'Guarded.mq5', content: EA }], { inputs: { Mode: 0 } });
    const loaded = added.outcome;
    if (loaded.kind !== 'mql5' || !loaded.result.ok) throw new Error(JSON.stringify(loaded.kind === 'mql5' ? loaded.result.diagnostics : loaded));
    const id = added.id!;
    let current = reading(0.5, 0.9);
    runtime.bot.brain.read = () => current;
    startBot(runtime);
    for (let i = 0; i < 100 && eaInfo(runtime).status !== 'running'; i += 1) await settle(5);
    let time = Date.now();
    const tick = async () => {
      time += 1000;
      runtime.feed.pushTick({ symbol: 'XAUUSD', bid: 4300, ask: 4300.2, time });
      await runtime.experts.idle();
      await settle(0);
    };

    // Danger: the EA's buy is refused the way a broker refuses one.
    await tick();
    expect(master.listPositions()).toHaveLength(0);
    const logs = () => runtime.journal.list().map((l) => l.message);
    expect(logs().some((m) => /buy retcode 10006 .*AI guard: volatility 2\.5× its normal level/.test(m))).toBe(true);
    expect(logs().some((m) => /AI guard refused Guarded's BUY entry — volatility/.test(m))).toBe(true);

    // The AI firmly gives the other side: refused too.
    current = reading(0.2);
    await tick();
    expect(master.listPositions()).toHaveLength(0);
    expect(runtime.ai.status().guard.last).toMatch(/the AI gives SELL 80%/);

    // Calm and no objection: the entry goes through.
    current = reading(0.55);
    await tick();
    expect(master.listPositions()).toHaveLength(1);

    // Danger again — but closing is never blocked.
    current = reading(0.5, 0.95);
    await configureExpert(runtime, id, { inputs: { Mode: 1 } });
    for (let i = 0; i < 100 && eaInfo(runtime).status !== 'running'; i += 1) await settle(5);
    await tick();
    await settle(5);
    expect(master.listPositions()).toHaveLength(0);
    expect(runtime.ai.status().guard.vetoes).toBeGreaterThanOrEqual(2);

    // With the guard off, danger does not stop the EA.
    runtime.bot.updateConfig({ ai: { ...runtime.bot.config.ai, guardEas: false } });
    await configureExpert(runtime, id, { inputs: { Mode: 0 } });
    for (let i = 0; i < 100 && eaInfo(runtime).status !== 'running'; i += 1) await settle(5);
    await tick();
    expect(master.listPositions()).toHaveLength(1);
  });
});
