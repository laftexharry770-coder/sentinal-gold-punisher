import angelSource from '../../mql5/samples/Angel_Bot.mq5?raw';
import type { StrategyFile } from './api';

/** Angel Bot ships with the terminal, so it can be picked without an upload. */
export const ANGEL_BOT: StrategyFile = { name: 'Angel_Bot.mq5', content: angelSource, encoding: 'text' };

export function isAngelBot(fileName: string | null | undefined): boolean {
  return (fileName ?? '').toLowerCase() === ANGEL_BOT.name.toLowerCase();
}
