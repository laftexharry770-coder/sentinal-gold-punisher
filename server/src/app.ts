import { createRuntime, seedDemoAccounts, type Runtime } from '@sentinal/engine';
import { MetaApiAccount } from './broker/metaapi.js';
import { config } from './config.js';

export type { Runtime } from '@sentinal/engine';

/**
 * Server-side runtime: the shared engine plus the transport-bound providers
 * that only make sense in Node (MetaApi cloud routing).
 */
export function createServerRuntime(): Runtime {
  const runtime = createRuntime({
    seedPrice: config.seedPrice,
    tickIntervalMs: config.tickIntervalMs,
    seed: config.randomSeed,
    historyBars: config.historyBars,
    banner: 'Sentinal MT5 execution server online — XAUUSD feed live',
  });

  runtime.accounts.registerProvider('metaapi', (cfg) => new MetaApiAccount(cfg));
  seedDemoAccounts(runtime);
  return runtime;
}
