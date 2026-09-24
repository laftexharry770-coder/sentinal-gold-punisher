import { compileMql5, inspectEx5, type CompileResult, type Ex5Info, type KeyValueStore } from '@sentinal/mql5';
import type { ExpertSlot, Position, StrategyInfo, Tick } from '@sentinal/shared';
import { Emitter } from '../emitter.js';
import type { TradingAccount } from '../broker/account.js';
import type { Journal } from '../journal.js';
import { uid } from '../util.js';
import type { CopyTradeEngine } from './copier.js';
import { ExpertRunner, type HistoryProvider } from './expert.js';

export interface StrategyFile {
  name: string;
  /** Text for .mq5/.mqh; base64 for .ex5. */
  content: string;
  encoding?: 'text' | 'base64';
}

export type LoadStrategyResult = { kind: 'mql5'; result: CompileResult } | { kind: 'ex5'; info: Ex5Info };

/** An EA as it is kept: its files and its settings. */
export interface StoredExpert {
  id: string;
  fileName: string;
  kind: 'mql5' | 'ex5';
  enabled: boolean;
  bundled: boolean;
  timeframe: number;
  inputs: Record<string, string | number | boolean>;
  addedAt: number;
  files: StrategyFile[];
}

/** Where the library is kept between sessions (IndexedDB in a browser, a directory on the server). */
export interface ExpertLibraryStore {
  load(): Promise<StoredExpert[]>;
  save(expert: StoredExpert): Promise<void>;
  remove(id: string): Promise<void>;
}

export interface AddedExpert {
  /** The new EA's id, or null when it did not compile and was not added. */
  id: string | null;
  fileName: string;
  outcome: LoadStrategyResult;
}

interface Slot {
  stored: StoredExpert;
  runner: ExpertRunner | null;
  ex5: Ex5Info | null;
  compile: CompileResult | null;
}

function decodeBase64(text: string): Uint8Array {
  const binary = globalThis.atob ? globalThis.atob(text) : '';
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * The library of expert advisors.
 *
 * Keeps as many EAs as the operator adds. Each .mq5 is compiled once and gets
 * its own runner, inputs and chart timeframe; every one switched on runs on
 * the master when the bot is armed, all at once, and each OrderSend still
 * reaches the master and every follower in the same instant. An .ex5 cannot
 * run outside MetaTrader, so switching one on mirrors the trades it makes in
 * the operator's MT5 instead. Switching an EA on or off, or changing its
 * inputs, takes effect at once, even while the bot runs.
 */
export class ExpertBank extends Emitter {
  private readonly slots = new Map<string, Slot>();
  private store: ExpertLibraryStore | null = null;
  private history: HistoryProvider | null;
  private guard: ExpertRunner['entryGuard'] = null;
  private allowed = true;
  private publishTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly journal: Journal,
    private readonly dispatcher: () => CopyTradeEngine | null,
    history: HistoryProvider | null,
    private readonly storage?: KeyValueStore,
  ) {
    super();
    this.history = history;
  }

  setStore(store: ExpertLibraryStore | null): void {
    this.store = store;
  }

  setHistoryProvider(provider: HistoryProvider | null): void {
    this.history = provider;
    for (const slot of this.slots.values()) slot.runner?.setHistoryProvider(provider);
  }

  set entryGuard(guard: ExpertRunner['entryGuard']) {
    this.guard = guard;
    for (const slot of this.slots.values()) if (slot.runner) slot.runner.entryGuard = guard;
  }

  /** False blocks every EA's orders, as AutoTrading off would (the daily guards). */
  set tradingAllowed(allowed: boolean) {
    this.allowed = allowed;
    for (const slot of this.slots.values()) if (slot.runner) slot.runner.tradingAllowed = allowed;
  }

  /* --------------------------------------------------------------- */
  /* The library                                                      */
  /* --------------------------------------------------------------- */

  /**
   * Adds uploaded files. Every .mq5 becomes an EA of its own, compiled with
   * all the .mqh headers of the same upload; every .ex5 becomes a mirrored
   * one. An .mq5 that does not compile is reported and not added.
   */
  async add(
    files: StrategyFile[],
    options: Partial<Pick<StoredExpert, 'enabled' | 'bundled' | 'timeframe' | 'inputs' | 'addedAt' | 'id'>> & { persist?: boolean } = {},
  ): Promise<AddedExpert[]> {
    const headers = files.filter((f) => /\.mqh$/i.test(f.name));
    const mains = files.filter((f) => /\.(mq5|ex5)$/i.test(f.name));
    const added: AddedExpert[] = [];
    for (const main of mains) {
      const stored: StoredExpert = {
        id: mains.length === 1 && options.id ? options.id : uid('ea'),
        fileName: main.name,
        kind: /\.ex5$/i.test(main.name) ? 'ex5' : 'mql5',
        enabled: options.enabled ?? true,
        bundled: options.bundled ?? false,
        timeframe: options.timeframe ?? 1,
        inputs: { ...(options.inputs ?? {}) },
        addedAt: options.addedAt ?? Date.now(),
        files: main.name.toLowerCase().endsWith('.mq5') ? [main, ...headers] : [main],
      };
      const outcome = await this.install(stored);
      added.push({ id: outcome.ok ? stored.id : null, fileName: main.name, outcome: outcome.result });
      if (outcome.ok && options.persist !== false) await this.persist(stored);
    }
    this.publish();
    return added;
  }

  private async install(stored: StoredExpert): Promise<{ ok: boolean; result: LoadStrategyResult }> {
    const main = stored.files[0]!;
    if (stored.kind === 'mql5') {
      const headers = stored.files.slice(1).map((f) => ({ name: f.name, source: f.content }));
      const result = compileMql5(main.content, main.name, { files: headers });
      if (!result.ok) {
        const first = result.diagnostics.find((d) => d.severity === 'error');
        this.journal.write('error', null, `${main.name} did not compile${first ? ` — line ${first.line}: ${first.message}` : ''}`);
        return { ok: false, result: { kind: 'mql5', result } };
      }
      const runner = new ExpertRunner(this.journal, this.dispatcher, this.history, this.storage);
      runner.entryGuard = this.guard;
      runner.tradingAllowed = this.allowed;
      runner.on('strategy', () => this.publish());
      runner.on('opened', (position: Position) => this.emit('opened', position));
      await runner.load(result, main.name);
      this.replace(stored.id);
      this.slots.set(stored.id, { stored, runner, ex5: null, compile: result });
      const warnings = result.diagnostics.filter((d) => d.severity === 'warning').length;
      this.journal.write(
        'success',
        null,
        `${result.name} added to the library — ${result.inputs.length} input(s)${warnings ? `, ${warnings} warning(s)` : ''}${stored.enabled ? ', switched on' : ''}`,
      );
      return { ok: true, result: { kind: 'mql5', result } };
    }
    const bytes = main.encoding === 'base64' ? decodeBase64(main.content) : new TextEncoder().encode(main.content);
    const info = await inspectEx5(main.name, bytes);
    if (!info.looksCompiled) {
      this.journal.write('error', null, `${info.name} is text, not a compiled expert — if it is MQL5 source, save it as .mq5 and upload that.`);
      return { ok: false, result: { kind: 'ex5', info } };
    }
    this.replace(stored.id);
    this.slots.set(stored.id, { stored, runner: null, ex5: info, compile: null });
    this.journal.write('success', null, `${info.name} added — it runs in your MetaTrader on the master; its trades are copied while it is switched on`);
    return { ok: true, result: { kind: 'ex5', info } };
  }

  /** An id being reused (a restore): the old runner is let go first. */
  private replace(id: string): void {
    const old = this.slots.get(id);
    if (old?.runner?.running) void old.runner.stop();
    this.slots.delete(id);
  }

  /** Restores the saved library. EAs that no longer compile are reported and left out. */
  async restore(): Promise<number> {
    if (!this.store) return 0;
    let stored: StoredExpert[] = [];
    try {
      stored = await this.store.load();
    } catch (err) {
      this.journal.write('warn', null, `The EA library could not be read: ${err instanceof Error ? err.message : String(err)}`);
      return 0;
    }
    let count = 0;
    for (const s of [...stored].sort((a, b) => a.addedAt - b.addedAt)) {
      if (!s || !Array.isArray(s.files) || s.files.length === 0) continue;
      const outcome = await this.install({ ...s, inputs: { ...(s.inputs ?? {}) }, timeframe: s.timeframe || 1 });
      if (outcome.ok) count += 1;
    }
    this.publish();
    return count;
  }

  private async persist(stored: StoredExpert): Promise<void> {
    if (!this.store) return;
    try {
      await this.store.save(stored);
    } catch (err) {
      this.journal.write('warn', null, `${stored.fileName} could not be saved for next time: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async remove(id: string): Promise<boolean> {
    const slot = this.slots.get(id);
    if (!slot) return false;
    if (slot.runner?.running) await slot.runner.stop();
    this.slots.delete(id);
    try {
      await this.store?.remove(id);
    } catch {
      /* already gone */
    }
    this.journal.write('warn', null, `${slot.stored.fileName} removed from the library`);
    this.publish();
    return true;
  }

  /**
   * Switches an EA on or off. With the bot running (a master given) it starts
   * or stops at once; otherwise it runs from the next time the bot is armed.
   */
  async setEnabled(id: string, enabled: boolean, master: TradingAccount | null): Promise<boolean> {
    const slot = this.slots.get(id);
    if (!slot) return false;
    slot.stored.enabled = enabled;
    await this.persist(slot.stored);
    if (slot.runner) {
      if (!enabled && slot.runner.running) await slot.runner.stop();
      if (enabled && master) await this.startSlot(slot, master);
    }
    this.journal.write('info', null, `${slot.stored.fileName} switched ${enabled ? 'on' : 'off'}`);
    this.emit('mirror-changed');
    this.publish();
    return true;
  }

  /** New inputs or timeframe; a running EA restarts with them, as MT5 re-initialises one. */
  async configure(
    id: string,
    patch: { inputs?: Record<string, string | number | boolean>; timeframe?: number },
    master: TradingAccount | null,
  ): Promise<boolean> {
    const slot = this.slots.get(id);
    if (!slot) return false;
    if (patch.inputs) slot.stored.inputs = { ...patch.inputs };
    if (patch.timeframe) slot.stored.timeframe = patch.timeframe;
    await this.persist(slot.stored);
    if (slot.runner?.running && master) {
      await slot.runner.stop();
      const ok = await this.startSlot(slot, master);
      this.journal.write(ok ? 'info' : 'error', master.id, ok ? `${slot.stored.fileName} restarted with the new inputs` : `${slot.stored.fileName} failed to restart with the new inputs`);
    }
    this.publish();
    return true;
  }

  /* --------------------------------------------------------------- */
  /* Running                                                          */
  /* --------------------------------------------------------------- */

  private async startSlot(slot: Slot, master: TradingAccount): Promise<boolean> {
    if (!slot.runner || !slot.stored.enabled) return false;
    return slot.runner.start(master, slot.stored.timeframe, slot.stored.inputs);
  }

  /** Starts every EA that is switched on. Resolves with the names of those that started. */
  async startAll(master: TradingAccount): Promise<string[]> {
    const started: string[] = [];
    await Promise.all(
      [...this.slots.values()].map(async (slot) => {
        if (await this.startSlot(slot, master)) started.push(slot.runner!.info().name);
      }),
    );
    return started;
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.slots.values()].map((slot) => (slot.runner?.running ? slot.runner.stop() : undefined)));
  }

  onTick(tick: Tick): void {
    for (const slot of this.slots.values()) if (slot.stored.enabled && slot.runner?.running) slot.runner.onTick(tick);
  }

  notifyTrade(): void {
    for (const slot of this.slots.values()) slot.runner?.notifyTrade();
  }

  /** A position opened on the master: the fill of an EA's pending order counts as that EA's trade. */
  onOpened(position: Position): void {
    for (const slot of this.slots.values()) {
      if (slot.runner?.claims(position)) {
        this.emit('opened', position);
        return;
      }
    }
  }

  /** Resolves once every running EA has worked through its queued events. */
  async idle(): Promise<void> {
    await Promise.all([...this.slots.values()].map((slot) => slot.runner?.idle()));
  }

  /* --------------------------------------------------------------- */
  /* Reading                                                          */
  /* --------------------------------------------------------------- */

  get size(): number {
    return this.slots.size;
  }

  enabledSource(): { engine: string[]; mirrored: string[] } {
    const engine: string[] = [];
    const mirrored: string[] = [];
    for (const slot of this.slots.values()) {
      if (!slot.stored.enabled) continue;
      if (slot.runner) engine.push(slot.runner.info().name);
      else if (slot.ex5) mirrored.push(slot.ex5.name.replace(/\.ex5$/i, ''));
    }
    return { engine, mirrored };
  }

  runner(id: string): ExpertRunner | null {
    return this.slots.get(id)?.runner ?? null;
  }

  stored(id: string): StoredExpert | null {
    return this.slots.get(id)?.stored ?? null;
  }

  /** The id of the first EA with this file name, for callers that know it by name. */
  idOf(fileName: string): string | null {
    for (const [id, slot] of this.slots) if (slot.stored.fileName.toLowerCase() === fileName.toLowerCase()) return id;
    return null;
  }

  private info(slot: Slot, botRunning: boolean): StrategyInfo {
    if (slot.runner) return slot.runner.info();
    const ex5 = slot.ex5!;
    const active = botRunning && slot.stored.enabled;
    return {
      source: 'mirror',
      name: ex5.name.replace(/\.ex5$/i, ''),
      fileName: ex5.name,
      status: active ? 'running' : 'idle',
      detail: active ? 'copying every position it opens on the master' : null,
      inputs: [],
      diagnostics: [],
      fingerprint: ex5.sha256,
      comment: '',
      panel: [],
      lastTickMs: null,
      ticks: 0,
      loadedAt: slot.stored.addedAt,
    };
  }

  list(botRunning = false): ExpertSlot[] {
    return [...this.slots.values()]
      .sort((a, b) => a.stored.addedAt - b.stored.addedAt)
      .map((slot) => ({
        id: slot.stored.id,
        fileName: slot.stored.fileName,
        kind: slot.stored.kind,
        enabled: slot.stored.enabled,
        bundled: slot.stored.bundled,
        timeframe: slot.stored.timeframe,
        inputs: { ...slot.stored.inputs },
        addedAt: slot.stored.addedAt,
        info: this.info(slot, botRunning),
      }));
  }

  /** Library changes and EA status go out at most four times a second. */
  publish(): void {
    if (this.publishTimer) return;
    this.publishTimer = setTimeout(() => {
      this.publishTimer = null;
      this.emit('experts');
    }, 250);
  }
}
