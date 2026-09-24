import express, { Router, type Request, type Response } from 'express';
import {
  CommandError,
  MetaApiAccount,
  addAccount,
  addMetaApiFollower,
  closeAll,
  closePosition,
  addExperts,
  configureExpert,
  modifyPosition,
  placeOrder,
  removeAccount,
  removeExpert,
  setExpertEnabled,
  startBot,
  stopBot,
  updateAccount,
  updateBotConfig,
  useBuiltinStrategy,
  type StrategyFile,
} from '@sentinal/engine';
import type { AiConfig, BotConfig, CopySettings } from '@sentinal/shared';
import type { ServerContext } from './app.js';

function asNumber(value: unknown): number | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function asNullableNumber(value: unknown): number | null | undefined {
  if (value === null) return null;
  return asNumber(value);
}

function asBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return undefined;
}

/** Whitelist + coerce the bot config patch coming from the settings screen. */
export function parseBotPatch(body: Record<string, unknown>): Partial<BotConfig> {
  const patch: Partial<BotConfig> = {};
  const numeric: (keyof BotConfig)[] = [
    'riskPercent',
    'stopDistance',
    'rewardRatio',
    'lotSize',
    'stopLossUsd',
    'takeProfitUsd',
    'maxConcurrentPositions',
    'maxPositionsPerDirection',
    'entriesPerSignal',
    'entrySpacingUsd',
    'signalCooldownMs',
    'minSignalStrength',
    'maxSpread',
  ];
  for (const key of numeric) {
    const value = asNumber(body[key]);
    if (value !== undefined) (patch as Record<string, unknown>)[key] = value;
  }
  const nullableNumeric: (keyof BotConfig)[] = [
    'basketTakeProfitUsd',
    'basketStopLossUsd',
    'maxDailyLossUsd',
    'maxDailyTrades',
  ];
  for (const key of nullableNumeric) {
    if (!(key in body)) continue;
    const value = asNullableNumber(body[key]);
    if (value !== undefined) (patch as Record<string, unknown>)[key] = value;
  }

  const hedging = asBoolean(body.allowHedging);
  if (hedging !== undefined) patch.allowHedging = hedging;
  const enabled = asBoolean(body.enabled);
  if (enabled !== undefined) patch.enabled = enabled;

  if (body.sizing === 'fixed' || body.sizing === 'risk-percent') patch.sizing = body.sizing;
  if (body.execution === 'intrabar' || body.execution === 'bar-close') patch.execution = body.execution;
  const strategy = asStrategy(body.strategy);
  if (strategy) patch.strategy = strategy;
  const ai = parseAiPatch(body.ai);
  if (ai) patch.ai = ai as AiConfig;

  const burst = body.burst;
  if (burst && typeof burst === 'object') {
    const src = burst as Record<string, unknown>;
    const next: Partial<BotConfig['burst']> = {};
    for (const key of ['lot', 'positionsPerStep', 'balanceStep', 'maxPositions', 'takeProfitPrice', 'trendTimeframeMin', 'trendFastPeriod', 'trendSlowPeriod', 'reentryDelayMs'] as const) {
      const value = asNumber(src[key]);
      if (value !== undefined && value >= 0) next[key] = value;
    }
    if ('stopLossPrice' in src) {
      const value = asNullableNumber(src.stopLossPrice);
      if (value !== undefined) next.stopLossPrice = value && value > 0 ? value : null;
    }
    if (src.direction === 'ai' || src.direction === 'trend' || src.direction === 'buy' || src.direction === 'sell') next.direction = src.direction;
    if (typeof src.comment === 'string') next.comment = src.comment.slice(0, 16);
    patch.burst = next as BotConfig['burst'];
  }
  if (typeof body.symbol === 'string' && body.symbol.trim()) patch.symbol = body.symbol.trim();

  const dispatch = body.dispatch;
  if (dispatch && typeof dispatch === 'object') {
    const src = dispatch as Record<string, unknown>;
    const next: Partial<BotConfig['dispatch']> = {};
    if (src.mode === 'simultaneous' || src.mode === 'after-fill') next.mode = src.mode;
    const cancel = asBoolean(src.cancelOrphans);
    if (cancel !== undefined) next.cancelOrphans = cancel;
    patch.dispatch = next as BotConfig['dispatch'];
  }

  const zl = body.zeroLoss;
  if (zl && typeof zl === 'object') {
    const src = zl as Record<string, unknown>;
    const zeroLoss: Partial<BotConfig['zeroLoss']> = {};
    const zlEnabled = asBoolean(src.enabled);
    if (zlEnabled !== undefined) zeroLoss.enabled = zlEnabled;
    const align = asBoolean(src.requireSignalAlignment);
    if (align !== undefined) zeroLoss.requireSignalAlignment = align;
    for (const key of ['recoveryMultiplier', 'maxRecoveryLayers', 'minNetProfitUsd', 'maxDeficitUsd', 'maxRecoveryLot'] as const) {
      const value = asNumber(src[key]);
      if (value !== undefined) zeroLoss[key] = value;
    }
    patch.zeroLoss = zeroLoss as BotConfig['zeroLoss'];
  }
  return patch;
}

export function parseCopyPatch(body: Record<string, unknown>): Partial<CopySettings> {
  const patch: Partial<CopySettings> = {};
  for (const key of ['multiplier', 'fixedLot', 'minLot', 'maxLot', 'maxSlippage'] as const) {
    const value = asNumber(body[key]);
    if (value !== undefined) patch[key] = value;
  }
  for (const key of ['enabled', 'reverse', 'copyStopLoss', 'copyTakeProfit', 'copyCloses'] as const) {
    const value = asBoolean(body[key]);
    if (value !== undefined) patch[key] = value;
  }
  if (body.sizing === 'multiplier' || body.sizing === 'fixed' || body.sizing === 'balance-ratio') {
    patch.sizing = body.sizing;
  }
  if (typeof body.masterId === 'string' || body.masterId === null) {
    patch.masterId = body.masterId as string | null;
  }
  if (Array.isArray(body.symbolWhitelist)) {
    patch.symbolWhitelist = body.symbolWhitelist.filter((s): s is string => typeof s === 'string');
  }
  return patch;
}

/** Turns a rejected command into the status the caller should see. */
function fail(res: Response, err: unknown): void {
  if (err instanceof CommandError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  res.status(500).json({ error: err instanceof Error ? err.message : 'unexpected error' });
}

/** Uploaded strategy files, checked for shape before they reach the compiler. */
const STRATEGIES: BotConfig['strategy'][] = ['burst', 'ai', 'adaptive-scalp', 'momentum', 'mean-reversion', 'none'];

function asStrategy(value: unknown): BotConfig['strategy'] | undefined {
  return STRATEGIES.includes(value as BotConfig['strategy']) ? (value as BotConfig['strategy']) : undefined;
}

/** The AI's settings, each held to a sensible range; anything else is ignored. */
export function parseAiPatch(value: unknown): Partial<AiConfig> | null {
  if (!value || typeof value !== 'object') return null;
  const src = value as Record<string, unknown>;
  const out: Partial<AiConfig> = {};
  const ranges: [keyof AiConfig, number, number][] = [
    ['minProbability', 0.5, 0.95],
    ['riskPercent', 0.01, 10],
    ['maxRiskPercent', 0.01, 10],
    ['maxPositions', 1, 10],
    ['slAtr', 0.3, 6],
    ['rrMin', 0.5, 6],
    ['rrMax', 0.5, 10],
    ['breakevenAtr', 0, 10],
    ['trailStartAtr', 0, 10],
    ['trailAtr', 0.2, 6],
    ['dailyLossPercent', 0, 50],
    ['horizonBars', 1, 60],
    ['learningRate', 0.01, 2],
    ['guardDanger', 0.1, 1],
    ['guardAgainst', 0.5, 0.99],
  ];
  for (const [key, lo, hi] of ranges) {
    const n = asNumber(src[key]);
    if (n !== undefined) (out as Record<string, unknown>)[key] = Math.min(hi, Math.max(lo, n));
  }
  for (const key of ['exitOnFlip', 'tradeVolatile', 'guardEas'] as const) {
    const b = asBoolean(src[key]);
    if (b !== undefined) out[key] = b;
  }
  const claude = src.claude;
  if (claude && typeof claude === 'object') {
    const c = claude as Record<string, unknown>;
    const next: Partial<AiConfig['claude']> = {};
    const enabled = asBoolean(c.enabled);
    if (enabled !== undefined) next.enabled = enabled;
    const autoApply = asBoolean(c.autoApply);
    if (autoApply !== undefined) next.autoApply = autoApply;
    if (typeof c.model === 'string' && /^claude-[a-z0-9.-]{1,60}$/.test(c.model)) next.model = c.model;
    const interval = asNumber(c.intervalMin);
    if (interval !== undefined) next.intervalMin = Math.min(1440, Math.max(0, Math.round(interval)));
    const after = asNumber(c.afterTrades);
    if (after !== undefined) next.afterTrades = Math.min(500, Math.max(0, Math.round(after)));
    out.claude = next as AiConfig['claude'];
  }
  return out;
}

function parseFiles(body: unknown): StrategyFile[] {
  const files = (body as { files?: unknown } | null)?.files;
  if (!Array.isArray(files) || files.length === 0) throw new CommandError('Send the strategy as { files: [{ name, content, encoding }] }.');
  return files.map((f) => {
    const file = f as Record<string, unknown>;
    if (typeof file.name !== 'string' || typeof file.content !== 'string') throw new CommandError('Each file needs a name and content.');
    return { name: file.name, content: file.content, encoding: file.encoding === 'base64' ? 'base64' : 'text' };
  });
}

export function createRouter(context: ServerContext): Router {
  const router = Router();
  const { runtime } = context;
  const { accounts, bot, journal } = runtime;

  router.get('/health', (_req, res) => {
    res.json({ ok: true, uptime: process.uptime(), quote: runtime.feed.quote, session: context.session().status });
  });

  router.get('/state', (_req, res) => res.json(runtime.snapshot()));

  router.get('/session', (_req, res) => res.json(context.session()));

  /* ----------------------------- MetaApi ----------------------------- */

  const gateway = () => {
    if (!context.gateway) throw new CommandError('This server has no METAAPI_TOKEN.', 404);
    return context.gateway;
  };

  router.get('/metaapi/accounts', async (_req, res) => {
    try {
      res.json(await gateway().listAccounts());
    } catch (err) {
      fail(res, err);
    }
  });

  router.post('/metaapi/accounts', async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    try {
      if (typeof body.login !== 'string' || typeof body.password !== 'string' || typeof body.server !== 'string') {
        throw new CommandError('login, password and server are required');
      }
      res.status(201).json(
        await gateway().provision({
          name: typeof body.name === 'string' ? body.name : '',
          login: body.login.trim(),
          password: body.password,
          server: body.server.trim(),
          platform: body.platform === 'mt4' ? 'mt4' : 'mt5',
        }),
      );
    } catch (err) {
      fail(res, err);
    }
  });

  router.post('/metaapi/followers', async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    try {
      const link = context.link();
      if (!link) throw new CommandError('The MetaApi master is not connected yet.', 409);
      if (typeof body.metaApiId !== 'string') throw new CommandError('metaApiId is required');
      const copy = body.copy && typeof body.copy === 'object' ? parseCopyPatch(body.copy as Record<string, unknown>) : {};
      const account = await addMetaApiFollower(runtime, gateway(), link, body.metaApiId, copy);
      res.status(201).json(account.state());
    } catch (err) {
      fail(res, err);
    }
  });

  /* ---------------------------- accounts ---------------------------- */

  router.get('/accounts', (_req, res) => res.json(accounts.states()));

  router.post('/accounts', (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    try {
      const state = addAccount(runtime, {
        name: typeof body.name === 'string' ? body.name.trim() : '',
        login: typeof body.login === 'string' ? body.login.trim() : '',
        server: typeof body.server === 'string' ? body.server.trim() : '',
        provider: 'sim',
        role: body.role === 'master' || body.role === 'slave' ? body.role : 'standalone',
        broker: typeof body.broker === 'string' ? body.broker : undefined,
        currency: typeof body.currency === 'string' ? body.currency : undefined,
        leverage: asNumber(body.leverage),
        initialBalance: asNumber(body.initialBalance),
        copy: body.copy && typeof body.copy === 'object' ? parseCopyPatch(body.copy as Record<string, unknown>) : undefined,
      });
      res.status(201).json(state);
    } catch (err) {
      fail(res, err);
    }
  });

  router.patch('/accounts/:id', (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    try {
      res.json(
        updateAccount(runtime, req.params.id as string, {
          name: typeof body.name === 'string' ? body.name : undefined,
          role:
            body.role === 'master' || body.role === 'slave' || body.role === 'standalone'
              ? body.role
              : undefined,
          copy: body.copy && typeof body.copy === 'object' ? parseCopyPatch(body.copy as Record<string, unknown>) : undefined,
        }),
      );
    } catch (err) {
      fail(res, err);
    }
  });

  router.delete('/accounts/:id', (req, res) => {
    try {
      const link = context.link();
      if (link && link.master.id === req.params.id) {
        throw new CommandError('The master is set by METAAPI_MASTER_ID; change it there and restart.', 409);
      }
      if (link) link.followers = link.followers.filter((f) => f.id !== req.params.id);
      res.json(removeAccount(runtime, req.params.id as string));
    } catch (err) {
      fail(res, err);
    }
  });

  router.post('/accounts/:id/stream-every-tick', async (req, res) => {
    try {
      const account = accounts.get(req.params.id as string);
      if (!(account instanceof MetaApiAccount)) throw new CommandError('Only MetaApi accounts stream quotes.', 404);
      await account.streamEveryTick();
      res.json(account.state());
    } catch (err) {
      fail(res, err);
    }
  });

  /* ---------------------------- trading ----------------------------- */

  router.get('/positions', (_req, res) => res.json(accounts.allPositions()));

  router.get('/history', (req, res) => {
    res.json(accounts.allHistory(asNumber(req.query.limit) ?? 200));
  });

  router.post('/orders', async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    try {
      const result = await placeOrder(runtime, {
        accountId: typeof body.accountId === 'string' ? body.accountId : undefined,
        symbol: typeof body.symbol === 'string' ? body.symbol : undefined,
        side: body.side as 'buy' | 'sell',
        volume: asNumber(body.volume),
        legs: asNumber(body.legs),
        stopLossUsd: 'stopLossUsd' in body ? asNullableNumber(body.stopLossUsd) ?? null : undefined,
        takeProfitUsd: 'takeProfitUsd' in body ? asNullableNumber(body.takeProfitUsd) ?? null : undefined,
        comment: typeof body.comment === 'string' ? body.comment : undefined,
      });
      res.status(201).json(result);
    } catch (err) {
      fail(res, err);
    }
  });

  router.post('/positions/:id/close', async (req, res) => {
    try {
      res.json(await closePosition(runtime, req.params.id as string));
    } catch (err) {
      fail(res, err);
    }
  });

  router.post('/positions/close-all', (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    try {
      res.json(
        closeAll(runtime, {
          accountId: typeof body.accountId === 'string' ? body.accountId : undefined,
          side: body.side === 'buy' || body.side === 'sell' ? body.side : undefined,
          profitableOnly: asBoolean(body.profitableOnly) ?? false,
        }),
      );
    } catch (err) {
      fail(res, err);
    }
  });

  router.patch('/positions/:id', async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    try {
      res.json(
        await modifyPosition(
          runtime,
          req.params.id as string,
          asNullableNumber(body.stopLoss) ?? null,
          asNullableNumber(body.takeProfit) ?? null,
        ),
      );
    } catch (err) {
      fail(res, err);
    }
  });

  /* ------------------------------ bot ------------------------------- */

  router.get('/bot', (_req, res) => res.json({ config: bot.config, stats: bot.stats() }));

  router.patch('/bot/config', (req, res) => {
    try {
      res.json(updateBotConfig(runtime, parseBotPatch((req.body ?? {}) as Record<string, unknown>)));
    } catch (err) {
      fail(res, err);
    }
  });

  router.post('/bot/start', (_req, res) => res.json(startBot(runtime)));

  router.post('/bot/stop', (req, res) => {
    res.json(stopBot(runtime, asBoolean((req.body ?? {}).closePositions) ?? false));
  });

  /* ----------------------------- strategy ---------------------------- */

  // EAs arrive as text or base64 (.ex5), several at once, so this route takes larger bodies.
  router.post('/experts', express.json({ limit: '24mb' }), async (req, res) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const enabled = asBoolean(body.enabled);
      res.json(await addExperts(runtime, parseFiles(req.body), enabled === undefined ? {} : { enabled }));
    } catch (err) {
      fail(res, err);
    }
  });

  router.get('/experts', (_req, res) => res.json(runtime.experts.list(bot.stats().running)));

  router.patch('/experts/:id', async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    try {
      const enabled = asBoolean(body.enabled);
      if (enabled !== undefined) await setExpertEnabled(runtime, req.params.id, enabled);
      if ((body.inputs && typeof body.inputs === 'object') || body.timeframe !== undefined) {
        const inputs: Record<string, string | number | boolean> = {};
        for (const [key, value] of Object.entries((body.inputs ?? {}) as Record<string, unknown>)) {
          if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') inputs[key] = value;
        }
        await configureExpert(runtime, req.params.id, {
          inputs: body.inputs && typeof body.inputs === 'object' ? inputs : undefined,
          timeframe: asNumber(body.timeframe),
        });
      }
      res.json(runtime.experts.list(bot.stats().running).find((e) => e.id === req.params.id) ?? null);
    } catch (err) {
      fail(res, err);
    }
  });

  router.delete('/experts/:id', async (req, res) => {
    try {
      res.json(await removeExpert(runtime, req.params.id));
    } catch (err) {
      fail(res, err);
    }
  });

  router.post('/strategy/builtin', (req, res) => {
    const strategy = asStrategy(((req.body ?? {}) as Record<string, unknown>).strategy);
    if (!strategy) return fail(res, new CommandError(`strategy must be one of: ${STRATEGIES.join(', ')}`));
    res.json(useBuiltinStrategy(runtime, strategy));
  });

  /* -------------------------------- AI -------------------------------- */

  router.get('/ai', (_req, res) => res.json(runtime.ai.status()));

  router.post('/ai/review', async (_req, res) => {
    try {
      const review = await runtime.ai.review('request');
      if (!review) throw new CommandError('Claude review needs ANTHROPIC_API_KEY set on the server, and none may already be running.', 409);
      res.json(review);
    } catch (err) {
      fail(res, err);
    }
  });

  router.post('/ai/pending/approve', (_req, res) => res.json(runtime.ai.approvePending()));
  router.post('/ai/pending/dismiss', (_req, res) => {
    runtime.ai.dismissPending();
    res.json({ ok: true });
  });
  router.post('/ai/resume', (_req, res) => {
    runtime.ai.resume();
    res.json({ ok: true });
  });

  router.get('/recoveries', (_req, res) => res.json(bot.listRecoveries()));

  router.get('/logs', (_req, res) => res.json(journal.list()));

  return router;
}
