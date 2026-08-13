import { createRuntime, seedDemoAccounts, type Runtime } from '@sentinal/engine';
import { config } from './config.js';

export type { Runtime } from '@sentinal/engine';

/**
 * Server-side runtime: the shared engine on a simulated feed.
 *
 * Live Deriv routing lives in the browser build, where the operator's own API
 * token never has to leave their machine.
 */
export function createServerRuntime(): Runtime {
  const runtime = createRuntime({
    seedPrice: config.seedPrice,
    tickIntervalMs: config.tickIntervalMs,
    seed: config.randomSeed,
    historyBars: config.historyBars,
    banner: 'Sentinal MT5 execution server online — XAUUSD feed live',
  });

  seedDemoAccounts(runtime);
  return runtime;
}
