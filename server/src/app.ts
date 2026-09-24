import { readFileSync } from 'node:fs';
import path from 'node:path';
import MetaApi from 'metaapi.cloud-sdk/esm-node';
import {
  MetaApiGateway,
  addExperts,
  attachMetaApi,
  createClaudeReviewer,
  createRuntime,
  seedDemoAccounts,
  type MetaApiClient,
  type MetaApiLink,
  type Runtime,
  type StrategyFile,
} from '@sentinal/engine';
import type { AccountState, BotConfig } from '@sentinal/shared';
import { config } from './config.js';
import { StateDir } from './state.js';

export type { Runtime } from '@sentinal/engine';

export interface SessionView {
  status: 'demo' | 'connecting' | 'live' | 'error';
  error: string | null;
  /** Where orders go: MetaTrader, or simulated fills on real quotes. */
  execution: 'broker' | 'local';
  broker: {
    login: string;
    server: string;
    broker: string;
    currency: string;
    accountType: AccountState['accountType'];
    platform: AccountState['platform'];
    metaApiId: string | null;
  };
}

export interface ServerContext {
  runtime: Runtime;
  state: StateDir;
  gateway: MetaApiGateway | null;
  link(): MetaApiLink | null;
  session(): SessionView;
  /** Resolves once the first connection attempt has finished, either way. */
  ready: Promise<void>;
  stop(): void;
}

/** An .mq5 as MetaEditor saved it (UTF-16 or UTF-8), or an .ex5 as base64. */
export function readStrategyFromDisk(file: string): StrategyFile {
  const bytes = readFileSync(file);
  const name = path.basename(file);
  if (/\.ex5$/i.test(name)) return { name, content: bytes.toString('base64'), encoding: 'base64' };
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return { name, content: bytes.subarray(2).toString('utf16le'), encoding: 'text' };
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return { name, content: bytes.subarray(3).toString('utf8'), encoding: 'text' };
  return { name, content: bytes.toString('utf8'), encoding: 'text' };
}

/**
 * The execution server's runtime.
 *
 * With METAAPI_TOKEN set it trades the configured master and followers
 * through MetaApi, and keeps doing so with every browser closed — which is
 * what a copier needs. Without it, it runs the simulated demo market. The
 * uploaded strategy and the settings survive restarts in STATE_DIR.
 */
export function createServerContext(): ServerContext {
  const state = new StateDir(config.stateDir);
  const storage = state.keyValueStore();
  const live = Boolean(config.metaApi.token);
  const reviewer = config.anthropicApiKey ? createClaudeReviewer(config.anthropicApiKey) : null;

  const runtime = createRuntime({
    seedPrice: live ? 0 : config.seedPrice,
    tickIntervalMs: config.tickIntervalMs,
    seed: config.randomSeed,
    historyBars: config.historyBars,
    source: live ? 'external' : 'simulated',
    storage,
    library: state.expertLibrary(),
    aiStore: state.aiStore(),
    aiReviewer: config.anthropicApiKey ? () => reviewer : undefined,
    banner: live ? 'Sentinal execution server — connecting to MetaApi' : 'Sentinal execution server — demo market (no METAAPI_TOKEN set)',
  });

  runtime.bot.on('bot', (view: { config: BotConfig }) => state.saveBotConfig(view.config));

  let link: MetaApiLink | null = null;
  let session: SessionView = {
    status: live ? 'connecting' : 'demo',
    error: null,
    execution: live && config.metaApi.liveExecution ? 'broker' : 'local',
    broker: {
      login: '',
      server: live ? 'MetaApi' : 'demo',
      broker: live ? 'MetaApi' : 'Sentinal demo',
      currency: 'USD',
      accountType: 'sim',
      platform: 'sim',
      metaApiId: null,
    },
  };
  let stopped = false;
  let retryTimer: NodeJS.Timeout | null = null;

  const restore = async (): Promise<void> => {
    const saved = state.botConfig() as (Partial<BotConfig> & { source?: string; expertInputs?: Record<string, string | number | boolean>; expertTimeframe?: number }) | null;
    if (saved) {
      // Settings from before the EA library carried one EA's inputs and a source; they move to the EA itself.
      const { enabled: _enabled, symbol: _symbol, source: _source, expertInputs: _inputs, expertTimeframe: _tf, ...rest } = saved;
      runtime.bot.updateConfig({ ...rest, enabled: false });
    }
    try {
      await runtime.experts.restore();
      const legacy = state.takeLegacyStrategy();
      if (legacy && runtime.experts.size === 0) {
        await addExperts(runtime, legacy.files, { enabled: legacy.active, inputs: saved?.expertInputs ?? {}, timeframe: saved?.expertTimeframe ?? 1 });
        // It was the strategy in use: it trades alone, as it did.
        if (legacy.active) runtime.bot.updateConfig({ strategy: 'none' });
      }
      if (runtime.experts.size === 0 && config.strategyFile) {
        await addExperts(runtime, [readStrategyFromDisk(config.strategyFile)]);
      }
    } catch (err) {
      runtime.journal.write('warn', null, `The EA library could not be restored: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const client: MetaApiClient | null = live
    ? new MetaApi(config.metaApi.token, { requestTimeout: 60, retryOpts: { retries: 3, minDelayInSeconds: 1, maxDelayInSeconds: 30 } })
    : null;
  const gateway = client ? new MetaApiGateway(client) : null;

  const connect = async (attempt: number): Promise<void> => {
    if (!gateway || stopped) return;
    try {
      if (!config.metaApi.masterId) {
        const accounts = await gateway.listAccounts();
        throw new Error(
          `Set METAAPI_MASTER_ID to one of: ${accounts.map((a) => `${a.id} (${a.name}, ${a.login} @ ${a.server})`).join('; ') || 'no accounts on this token'}`,
        );
      }
      link = await attachMetaApi(runtime, gateway, {
        masterId: config.metaApi.masterId,
        followerIds: config.metaApi.followerIds,
        symbol: config.metaApi.symbol,
        paper: !config.metaApi.liveExecution,
        followerCopy: { sizing: 'multiplier', multiplier: config.metaApi.followerMultiplier },
      });
      const master = link.master.state();
      session = {
        status: 'live',
        error: null,
        execution: config.metaApi.liveExecution ? 'broker' : 'local',
        broker: {
          login: master.login,
          server: master.server,
          broker: master.broker,
          currency: master.currency,
          accountType: master.accountType,
          platform: master.platform,
          metaApiId: master.metaApiId,
        },
      };
      runtime.journal.write(
        config.metaApi.liveExecution ? 'warn' : 'info',
        link.master.id,
        `Connected to ${master.broker} · ${master.login} (${master.accountType}) with ${link.followers.length} follower(s) — ` +
          (config.metaApi.liveExecution ? 'real orders' : 'paper fills on real quotes'),
      );
      await restore();
      autoStart();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      session = { ...session, status: 'error', error: message };
      runtime.journal.write('error', null, `MetaApi: ${message}`);
      // Keep trying, backing off to five minutes: a server should heal itself.
      const delay = Math.min(300, 15 * 2 ** Math.min(attempt, 4)) * 1000;
      retryTimer = setTimeout(() => void connect(attempt + 1), delay);
    }
  };

  function autoStart(): void {
    if (!config.autoStartBot || runtime.bot.stats().running) return;
    runtime.journal.write('info', null, 'AUTO_START_BOT is on — starting the bot');
    runtime.bot.start();
  }

  let ready: Promise<void>;
  if (live) {
    ready = connect(0);
  } else {
    seedDemoAccounts(runtime);
    ready = restore().then(autoStart);
  }

  return {
    runtime,
    state,
    gateway,
    link: () => link,
    session: () => session,
    ready,
    stop: () => {
      stopped = true;
      if (retryTimer) clearTimeout(retryTimer);
      link?.detach();
      runtime.stop();
      client?.close();
    },
  };
}
