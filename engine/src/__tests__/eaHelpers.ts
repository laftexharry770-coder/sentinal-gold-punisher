import type { StrategyInfo } from '@sentinal/shared';
import { addExperts, type AddedExpert, type StrategyFile } from '../commands.js';
import type { Runtime } from '../runtime.js';

/** Adds an EA to the library, switched on, with the built-in model off: the EA alone trades. */
export async function loadEa(
  runtime: Runtime,
  files: StrategyFile[],
  options: { inputs?: Record<string, string | number | boolean>; timeframe?: number } = {},
): Promise<AddedExpert> {
  runtime.bot.updateConfig({ strategy: 'none' });
  const [added] = await addExperts(runtime, files, { timeframe: 1, ...options });
  return added!;
}

/** The first EA's live status, as the terminal shows it. */
export function eaInfo(runtime: Runtime): StrategyInfo {
  const slot = runtime.experts.list(runtime.bot.stats().running)[0];
  if (!slot) throw new Error('no EA in the library');
  return slot.info;
}
