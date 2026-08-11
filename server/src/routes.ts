import { Router, type Request, type Response } from 'express';
import {
  CommandError,
  addAccount,
  closeAll,
  closePosition,
  modifyPosition,
  placeOrder,
  removeAccount,
  startBot,
  stopBot,
  updateAccount,
  updateBotConfig,
  type Runtime,
} from '@sentinal/engine';
import type { BotConfig, CopySettings } from '@sentinal/shared';

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

  if (body.execution === 'intrabar' || body.execution === 'bar-close') patch.execution = body.execution;
  if (
    body.strategy === 'adaptive-scalp' ||
    body.strategy === 'momentum' ||
    body.strategy === 'mean-reversion'
  ) {
    patch.strategy = body.strategy;
  }
  if (typeof body.symbol === 'string' && body.symbol.trim()) patch.symbol = body.symbol.trim().toUpperCase();

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

export function createRouter(runtime: Runtime): Router {
  const router = Router();
  const { accounts, bot, journal } = runtime;

  router.get('/health', (_req, res) => {
    res.json({ ok: true, uptime: process.uptime(), quote: runtime.feed.quote });
  });

  router.get('/state', (_req, res) => res.json(runtime.snapshot()));

  /* ---------------------------- accounts ---------------------------- */

  router.get('/accounts', (_req, res) => res.json(accounts.states()));

  router.post('/accounts', (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    try {
      const state = addAccount(runtime, {
        name: typeof body.name === 'string' ? body.name.trim() : '',
        login: typeof body.login === 'string' ? body.login.trim() : '',
        server: typeof body.server === 'string' ? body.server.trim() : '',
        provider: body.provider === 'metaapi' || body.provider === 'mt5' ? body.provider : 'sim',
        role: body.role === 'master' || body.role === 'slave' ? body.role : 'standalone',
        broker: typeof body.broker === 'string' ? body.broker : undefined,
        currency: typeof body.currency === 'string' ? body.currency : undefined,
        leverage: asNumber(body.leverage),
        initialBalance: asNumber(body.initialBalance),
        metaApiAccountId: typeof body.metaApiAccountId === 'string' ? body.metaApiAccountId : undefined,
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
      res.json(removeAccount(runtime, req.params.id as string));
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

  router.patch('/positions/:id', (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    try {
      res.json(
        modifyPosition(
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

  router.get('/recoveries', (_req, res) => res.json(bot.listRecoveries()));

  router.get('/logs', (_req, res) => res.json(journal.list()));

  return router;
}
