import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { addExperts, removeExpert, setExpertEnabled, startBot, stopBot, useBuiltinStrategy } from '../commands.js';
import type { ExpertLibraryStore, StoredExpert } from '../engine/bank.js';
import { createRuntime } from '../runtime.js';

const settle = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
const angel = readFileSync(fileURLToPath(new URL('../../../mql5/samples/Angel_Bot.mq5', import.meta.url)), 'utf8');

/** Buys once and holds, under its own magic number. */
const BUYER = `
#include <Trade/Trade.mqh>
#include "Shared.mqh"
CTrade trade;
input double Lots = 0.02;
int OnInit() { trade.SetExpertMagicNumber(SHARED_MAGIC); return(INIT_SUCCEEDED); }
void OnTick()
  {
   for(int i = PositionsTotal() - 1; i >= 0; i--)
      if(PositionGetTicket(i) > 0 && PositionGetInteger(POSITION_MAGIC) == SHARED_MAGIC) return;
   trade.Buy(Lots);
  }
`;
/** Sells once and holds, under the next magic number. */
const SELLER = `
#include <Trade/Trade.mqh>
#include "Shared.mqh"
CTrade trade;
int OnInit() { trade.SetExpertMagicNumber(SHARED_MAGIC + 1); return(INIT_SUCCEEDED); }
void OnTick()
  {
   for(int i = PositionsTotal() - 1; i >= 0; i--)
      if(PositionGetTicket(i) > 0 && PositionGetInteger(POSITION_MAGIC) == SHARED_MAGIC + 1) return;
   trade.Sell(0.03);
  }
`;
const HEADER = '#define SHARED_MAGIC 777\n';

class MemoryStore implements ExpertLibraryStore {
  readonly data = new Map<string, StoredExpert>();
  async load() {
    return [...this.data.values()].map((e) => JSON.parse(JSON.stringify(e)) as StoredExpert);
  }
  async save(e: StoredExpert) {
    this.data.set(e.id, JSON.parse(JSON.stringify(e)) as StoredExpert);
  }
  async remove(id: string) {
    this.data.delete(id);
  }
}

function setup(store = new MemoryStore(), balance = 10_000) {
  const runtime = createRuntime({ seedPrice: 4300, tickIntervalMs: 1000, seed: 4, historyBars: 200, library: store });
  const master = runtime.accounts.add({ name: 'Master', login: '1', server: 'sim', role: 'master', initialBalance: balance, leverage: 100_000 });
  let time = Date.now();
  let price = runtime.feed.quote?.bid ?? 4300;
  const tick = async (move = 0) => {
    price += move;
    time += 1000;
    runtime.feed.pushTick({ symbol: 'XAUUSD', bid: +price.toFixed(2), ask: +(price + 0.2).toFixed(2), time });
    await runtime.experts.idle();
    await settle(0);
  };
  const waitRunning = async (count: number) => {
    for (let i = 0; i < 200 && runtime.experts.list(true).filter((e) => e.info.status === 'running').length < count; i += 1) await settle(5);
  };
  return { runtime, master, store, tick, waitRunning };
}

describe('the EA library', () => {
  it('adds several EAs from one upload, each compiled with the shared header', async () => {
    const { runtime, store } = setup();
    const added = await addExperts(runtime, [
      { name: 'Buyer.mq5', content: BUYER },
      { name: 'Seller.mq5', content: SELLER },
      { name: 'Shared.mqh', content: HEADER },
    ]);
    expect(added.map((a) => [a.fileName, a.id !== null])).toEqual([
      ['Buyer.mq5', true],
      ['Seller.mq5', true],
    ]);
    const list = runtime.experts.list();
    expect(list.map((e) => [e.fileName, e.kind, e.enabled])).toEqual([
      ['Buyer.mq5', 'mql5', true],
      ['Seller.mq5', 'mql5', true],
    ]);
    expect(list[0]!.info.inputs.map((i) => i.name)).toEqual(['Lots']);
    expect(store.data.size).toBe(2);
    expect([...store.data.values()].every((e) => e.files.some((f) => f.name === 'Shared.mqh'))).toBe(true);
  });

  it('runs every EA switched on at the same time, beside Burst, each keeping to its own trades', async () => {
    const { runtime, master, tick, waitRunning } = setup(new MemoryStore(), 10);
    const [buyer, seller] = await addExperts(runtime, [
      { name: 'Buyer.mq5', content: BUYER },
      { name: 'Seller.mq5', content: SELLER },
      { name: 'Shared.mqh', content: HEADER },
    ]);
    useBuiltinStrategy(runtime, 'burst');
    runtime.bot.updateConfig({ burst: { ...runtime.bot.config.burst, direction: 'buy' } });
    startBot(runtime);
    await waitRunning(2);
    await tick();
    await tick();
    const mine = (magic: number) => master.listPositions().filter((p) => p.magic === magic);
    expect(mine(777)).toHaveLength(1);
    expect(mine(778)).toHaveLength(1);
    // Burst sent its 16 even though the EAs hold positions of their own.
    expect(master.listPositions().filter((p) => p.comment === 'Sentinal BUY')).toHaveLength(16);
    // Nothing more: Burst waits on its own positions, each EA on its own.
    await tick();
    expect(master.listPositions()).toHaveLength(18);

    // Switched off while running: the Seller stops, the Buyer carries on.
    await setExpertEnabled(runtime, seller!.id!, false);
    const byName = () => Object.fromEntries(runtime.experts.list(true).map((e) => [e.fileName, e.info.status]));
    expect(byName()).toEqual({ 'Buyer.mq5': 'running', 'Seller.mq5': 'stopped' });
    master.requestCloseAll('manual', (p) => p.magic === 778);
    await tick();
    expect(mine(778)).toHaveLength(0);
    // … and back on: it starts at once.
    await setExpertEnabled(runtime, seller!.id!, true);
    await waitRunning(2);
    await tick();
    expect(mine(778)).toHaveLength(1);

    stopBot(runtime);
    await settle(10);
    expect(runtime.experts.list(false).every((e) => e.info.status === 'stopped')).toBe(true);
    expect(buyer!.id).not.toBe(seller!.id);
  });

  it('keeps the library for next time, and forgets what is removed', async () => {
    const store = new MemoryStore();
    const first = setup(store);
    const [a, b] = await addExperts(first.runtime, [
      { name: 'Buyer.mq5', content: BUYER },
      { name: 'Shared.mqh', content: HEADER },
      { name: 'Angel_Bot.mq5', content: angel },
    ]);
    await setExpertEnabled(first.runtime, b!.id!, false);
    await first.runtime.experts.configure(a!.id!, { inputs: { Lots: 0.05 }, timeframe: 5 }, null);
    await removeExpert(first.runtime, a!.id!);
    await addExperts(first.runtime, [{ name: 'Seller.mq5', content: SELLER }, { name: 'Shared.mqh', content: HEADER }], { enabled: false });

    const second = setup(store);
    expect(await second.runtime.experts.restore()).toBe(2);
    expect(second.runtime.experts.list().map((e) => [e.fileName, e.enabled])).toEqual([
      ['Angel_Bot.mq5', false],
      ['Seller.mq5', false],
    ]);
    expect(second.runtime.experts.list()[0]!.info.inputs).toHaveLength(28);
  });

  it('refuses to arm with nothing to run', async () => {
    const { runtime } = setup();
    useBuiltinStrategy(runtime, 'none');
    startBot(runtime);
    expect(runtime.bot.stats().running).toBe(false);
    expect(runtime.journal.list().some((l) => /Nothing to run: pick Burst or the AI, or switch on an EA/.test(l.message))).toBe(true);
  });

  it('adds an EA uploaded while the bot runs and starts it at once', async () => {
    const { runtime, master, tick, waitRunning } = setup();
    useBuiltinStrategy(runtime, 'none');
    await addExperts(runtime, [{ name: 'Seller.mq5', content: SELLER }, { name: 'Shared.mqh', content: HEADER }]);
    startBot(runtime);
    await waitRunning(1);
    await addExperts(runtime, [{ name: 'Buyer.mq5', content: BUYER }, { name: 'Shared.mqh', content: HEADER }]);
    await waitRunning(2);
    await tick();
    expect(master.listPositions().map((p) => p.magic).sort()).toEqual([777, 778]);
  });
});
