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
  ai: 'sentinal.ai.v1',
  claude: 'sentinal.anthropic.v1',
  angelSeeded: 'sentinal.library.angel.v1',
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

/**
 * The single uploaded EA an earlier version kept, if any, and whether it was
 * the strategy in use. Taken once into the EA library, then removed.
 */
export function takeLegacyStrategy(): { files: StrategyFile[]; active: boolean } | null {
  const saved = read<{ files?: StrategyFile[]; active?: boolean }>(KEYS.strategy);
  write(KEYS.strategy, null);
  if (!saved || !Array.isArray(saved.files) || saved.files.length === 0) return null;
  return { files: saved.files, active: saved.active !== false };
}

/** The AI's learned model, so it carries on learning from where it left off. */
export function loadAiModel(): unknown {
  return read<unknown>(KEYS.ai);
}

export function saveAiModel(state: unknown): void {
  write(KEYS.ai, state);
}

/** The Anthropic API key for Claude's reviews — kept in this browser only, sent only to Anthropic. */
export function loadClaudeKey(): string | null {
  const key = read<string>(KEYS.claude);
  return typeof key === 'string' && key.trim() ? key.trim() : null;
}

export function saveClaudeKey(key: string | null): void {
  write(KEYS.claude, key && key.trim() ? key.trim() : null);
}

/** Whether Angel Bot has been put in this browser's library once already (it is not put back after removal). */
export function angelSeeded(): boolean {
  return read<boolean>(KEYS.angelSeeded) === true;
}

export function markAngelSeeded(): void {
  write(KEYS.angelSeeded, true);
}

/** Settings worth keeping; what the session decides (symbol, arming) is left out. */
export type SavedBotConfig = Omit<Partial<BotConfig>, 'enabled' | 'symbol'> & {
  /* Settings from before the EA library, read once to move one EA's inputs onto it. */
  source?: string;
  expertInputs?: Record<string, string | number | boolean>;
  expertTimeframe?: number;
};

export function loadBotConfig(): SavedBotConfig | null {
  return read<SavedBotConfig>(KEYS.bot);
}

export function saveBotConfig(config: BotConfig): void {
  const { enabled: _enabled, symbol: _symbol, ...rest } = config;
  write(KEYS.bot, rest);
}
