import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { KeyValueStore } from '@sentinal/mql5';
import type { StrategyFile } from '@sentinal/engine';
import type { BotConfig } from '@sentinal/shared';

/**
 * The server's memory across restarts: the uploaded strategy, the settings,
 * and an EA's global variables and files. Plain JSON in one directory, each
 * file replaced atomically so a crash mid-write never leaves half a file.
 */
export class StateDir {
  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  read<T>(name: string): T | null {
    try {
      return JSON.parse(readFileSync(path.join(this.dir, name), 'utf8')) as T;
    } catch {
      return null;
    }
  }

  write(name: string, value: unknown): void {
    const target = path.join(this.dir, name);
    const temp = `${target}.tmp`;
    writeFileSync(temp, JSON.stringify(value));
    renameSync(temp, target);
  }

  strategy(): StrategyFile[] | null {
    const saved = this.read<{ files: StrategyFile[] }>('strategy.json');
    return saved && Array.isArray(saved.files) && saved.files.length > 0 ? saved.files : null;
  }

  saveStrategy(files: StrategyFile[] | null): void {
    this.write('strategy.json', { files: files ?? [], savedAt: Date.now() });
  }

  botConfig(): Partial<BotConfig> | null {
    return this.read<Partial<BotConfig>>('bot.json');
  }

  saveBotConfig(config: BotConfig): void {
    const { enabled: _enabled, symbol: _symbol, source: _source, ...rest } = config;
    this.write('bot.json', rest);
  }

  /** Global variables and files an EA writes, kept the way MetaTrader keeps them. */
  keyValueStore(): KeyValueStore {
    const data = new Map(Object.entries(this.read<Record<string, string>>('ea-storage.json') ?? {}));
    let timer: NodeJS.Timeout | null = null;
    const flush = () => {
      timer = null;
      this.write('ea-storage.json', Object.fromEntries(data));
    };
    const schedule = () => {
      timer ??= setTimeout(flush, 250);
    };
    return {
      get: (key) => data.get(key) ?? null,
      set: (key, value) => {
        data.set(key, value);
        schedule();
      },
      remove: (key) => {
        data.delete(key);
        schedule();
      },
      keys: (prefix) => [...data.keys()].filter((k) => k.startsWith(prefix)),
    };
  }
}
