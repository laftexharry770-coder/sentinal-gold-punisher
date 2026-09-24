import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { KeyValueStore } from '@sentinal/mql5';
import type { AiStore, BrainState, ExpertLibraryStore, StoredExpert, StrategyFile } from '@sentinal/engine';
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

  /**
   * The single uploaded EA an earlier version kept, if any, and whether it
   * was the strategy in use. Taken once into the EA library, then removed.
   */
  takeLegacyStrategy(): { files: StrategyFile[]; active: boolean } | null {
    const saved = this.read<{ files?: StrategyFile[]; active?: boolean }>('strategy.json');
    const file = path.join(this.dir, 'strategy.json');
    if (existsSync(file)) renameSync(file, `${file}.migrated`);
    if (!saved || !Array.isArray(saved.files) || saved.files.length === 0) return null;
    return { files: saved.files, active: saved.active !== false };
  }

  /** The EA library: one JSON file per EA under experts/. */
  expertLibrary(): ExpertLibraryStore {
    const dir = path.join(this.dir, 'experts');
    mkdirSync(dir, { recursive: true });
    const safe = (id: string) => id.replace(/[^A-Za-z0-9_-]/g, '');
    return {
      load: async () => {
        const out: StoredExpert[] = [];
        for (const name of readdirSync(dir)) {
          if (!name.endsWith('.json')) continue;
          try {
            out.push(JSON.parse(readFileSync(path.join(dir, name), 'utf8')) as StoredExpert);
          } catch {
            /* a damaged entry is skipped */
          }
        }
        return out;
      },
      save: async (expert) => {
        const target = path.join(dir, `${safe(expert.id)}.json`);
        writeFileSync(`${target}.tmp`, JSON.stringify(expert));
        renameSync(`${target}.tmp`, target);
      },
      remove: async (id) => {
        rmSync(path.join(dir, `${safe(id)}.json`), { force: true });
      },
    };
  }

  /** The AI's learned model. */
  aiStore(): AiStore {
    return {
      load: () => this.read<BrainState>('ai-model.json'),
      save: (state) => this.write('ai-model.json', state),
    };
  }

  botConfig(): Partial<BotConfig> | null {
    return this.read<Partial<BotConfig>>('bot.json');
  }

  saveBotConfig(config: BotConfig): void {
    const { enabled: _enabled, symbol: _symbol, ...rest } = config;
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
