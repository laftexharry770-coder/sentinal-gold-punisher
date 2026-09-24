import type { StrategyFile } from '@sentinal/engine';
import type { BotConfig } from '@sentinal/shared';
import type { SavedMetaApi } from './session';

/**
 * What the terminal keeps in this browser between visits. Every read and
 * write is guarded: private windows, blocked storage and a full quota must
 * never stop the terminal from working — they only cost the convenience.
 */

const KEYS = {
  metaApi: 'sentinal.metaapi.v1',
  strategy: 'sentinal.strategy.v1',
  bot: 'sentinal.bot.v1',
} as const;

function read<T>(key: string): T | null {
  try {
    const raw = globalThis.localStorage?.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function write(key: string, value: unknown): boolean {
  try {
    if (value === null) globalThis.localStorage?.removeItem(key);
    else globalThis.localStorage?.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export function loadMetaApiCredentials(): SavedMetaApi | null {
  const saved = read<SavedMetaApi>(KEYS.metaApi);
  if (!saved || typeof saved.token !== 'string' || !saved.token) return null;
  return {
    token: saved.token,
    masterId: typeof saved.masterId === 'string' ? saved.masterId : '',
    followerIds: Array.isArray(saved.followerIds) ? saved.followerIds.filter((id) => typeof id === 'string') : [],
    symbol: typeof saved.symbol === 'string' ? saved.symbol : '',
  };
}

export function saveMetaApiCredentials(value: SavedMetaApi | null): void {
  write(KEYS.metaApi, value);
}

export interface SavedStrategy {
  files: StrategyFile[];
  savedAt: number;
}

export function loadStrategyFiles(): SavedStrategy | null {
  const saved = read<SavedStrategy>(KEYS.strategy);
  if (!saved || !Array.isArray(saved.files) || saved.files.length === 0) return null;
  return saved;
}

/** False when the browser would not hold the files (a large .ex5 on a full quota). */
export function saveStrategyFiles(files: StrategyFile[] | null): boolean {
  return write(KEYS.strategy, files ? { files, savedAt: Date.now() } : null);
}

/** Settings worth keeping; what the session decides (symbol, source, arming) is left out. */
export type SavedBotConfig = Omit<Partial<BotConfig>, 'enabled' | 'symbol' | 'source'>;

export function loadBotConfig(): SavedBotConfig | null {
  return read<SavedBotConfig>(KEYS.bot);
}

export function saveBotConfig(config: BotConfig): void {
  const { enabled: _enabled, symbol: _symbol, source: _source, ...rest } = config;
  write(KEYS.bot, rest);
}
