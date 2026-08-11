import { Router, type Request, type Response } from 'express';
import { getSymbolSpec, roundLot, type BotConfig, type CopySettings, type Side } from '@sentinal/shared';
import type { Runtime } from './app.js';

function bad(res: Response, message: string): void {
  res.status(400).json({ error: message });
}

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
function parseBotPatch(body: Record<string, unknown>): Partial<BotConfig> {
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

function parseCopyPatch(body: Record<string, unknown>): Partial<CopySettings> {
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
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const login = typeof body.login === 'string' ? body.login.trim() : '';
    const server = typeof body.server === 'string' ? body.server.trim() : '';
    if (!name || !login || !server) return bad(res, 'name, login and server are required');

    const provider = body.provider === 'metaapi' || body.provider === 'mt5' ? body.provider : 'sim';
    const role = body.role === 'master' || body.role === 'slave' ? body.role : 'standalone';

    const account = accounts.add({
      name,
      login,
      server,
      provider,
      role,
      broker: typeof body.broker === 'string' ? body.broker : undefined,
      currency: typeof body.currency === 'string' ? body.currency : undefined,
      leverage: asNumber(body.leverage),
      initialBalance: asNumber(body.initialBalance),
      metaApiAccountId: typeof body.metaApiAccountId === 'string' ? body.metaApiAccountId : undefined,
      copy: body.copy && typeof body.copy === 'object' ? parseCopyPatch(body.copy as Record<string, unknown>) : undefined,
    });

    journal.write('success', account.id, `Linked ${account.config.name} (${account.config.provider}) on ${account.config.server}`);
    res.status(201).json(account.state());
  });

  router.patch('/accounts/:id', (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const patch: Record<string, unknown> = {};
    if (typeof body.name === 'string') patch.name = body.name;
    if (body.role === 'master' || body.role === 'slave' || body.role === 'standalone') patch.role = body.role;
    if (body.copy && typeof body.copy === 'object') patch.copy = parseCopyPatch(body.copy as Record<string, unknown>);

    const account = accounts.update(req.params.id as string, patch);
    if (!account) return res.status(404).json({ error: 'account not found' });
    res.json(account.state());
  });

  router.delete('/accounts/:id', (req, res) => {
    const id = req.params.id as string;
    const account = accounts.get(id);
    if (!account) return res.status(404).json({ error: 'account not found' });
    const name = account.config.name;
    accounts.remove(id);
    journal.write('warn', null, `Unlinked ${name}`);
    res.json({ ok: true });
  });

  /* ---------------------------- trading ----------------------------- */

  router.get('/positions', (_req, res) => res.json(accounts.allPositions()));

  router.get('/history', (req, res) => {
    const limit = asNumber(req.query.limit) ?? 200;
    res.json(accounts.allHistory(limit));
  });

  router.post('/orders', async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const accountId = typeof body.accountId === 'string' ? body.accountId : accounts.primary()?.id;
    if (!accountId) return bad(res, 'no account available');
    const account = accounts.get(accountId);
    if (!account) return res.status(404).json({ error: 'account not found' });

    const side: Side | undefined = body.side === 'buy' || body.side === 'sell' ? body.side : undefined;
    if (!side) return bad(res, 'side must be buy or sell');

    const symbol = typeof body.symbol === 'string' && body.symbol ? body.symbol.toUpperCase() : bot.config.symbol;
    const spec = getSymbolSpec(symbol);
    const volume = roundLot(spec, asNumber(body.volume) ?? bot.config.lotSize);
    const legs = Math.max(1, Math.min(50, Math.round(asNumber(body.legs) ?? 1)));

    const result = await bot.manualOrder(account, {
      symbol,
      side,
      volume,
      legs,
      stopLossUsd: body.stopLossUsd === null ? null : asNumber(body.stopLossUsd) ?? bot.config.stopLossUsd,
      takeProfitUsd: body.takeProfitUsd === null ? null : asNumber(body.takeProfitUsd) ?? bot.config.takeProfitUsd,
      comment: typeof body.comment === 'string' ? body.comment : undefined,
    });

    if (result.opened.length === 0) {
      return res.status(422).json({ error: result.errors[0] ?? 'order rejected', errors: result.errors });
    }
    res.status(201).json({ opened: result.opened, errors: result.errors });
  });

  router.post('/positions/:id/close', async (req, res) => {
    const id = req.params.id as string;
    const account = accounts.list().find((a) => a.getPosition(id));
    if (!account) return res.status(404).json({ error: 'position not found' });
    const trade = await account.submitClose(id, 'manual');
    if (!trade) return res.status(422).json({ error: 'close rejected by broker' });
    journal.write('trade', account.id, `Closed #${trade.ticket} manually (${trade.netProfit >= 0 ? '+' : ''}${trade.netProfit.toFixed(2)})`);
    res.json(trade);
  });

  router.post('/positions/close-all', (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const accountId = typeof body.accountId === 'string' ? body.accountId : undefined;
    const side = body.side === 'buy' || body.side === 'sell' ? body.side : undefined;
    const profitableOnly = asBoolean(body.profitableOnly) ?? false;

    const targets = accountId ? [accounts.get(accountId)].filter(Boolean) : accounts.list();
    let closed = 0;
    for (const account of targets) {
      if (!account) continue;
      const trades = account.closeAll('manual', (p) => {
        if (side && p.side !== side) return false;
        if (profitableOnly && p.profit <= 0) return false;
        return true;
      });
      closed += trades.length;
    }
    journal.write('warn', accountId ?? null, `Bulk close executed — ${closed} position(s)`);
    res.json({ closed });
  });

  router.patch('/positions/:id', (req, res) => {
    const id = req.params.id as string;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const account = accounts.list().find((a) => a.getPosition(id));
    if (!account) return res.status(404).json({ error: 'position not found' });
    const stopLoss = asNullableNumber(body.stopLoss) ?? null;
    const takeProfit = asNullableNumber(body.takeProfit) ?? null;
    account.modify(id, stopLoss, takeProfit);
    res.json(account.getPosition(id) ?? null);
  });

  /* ------------------------------ bot ------------------------------- */

  router.get('/bot', (_req, res) => res.json({ config: bot.config, stats: bot.stats() }));

  router.patch('/bot/config', (req, res) => {
    const patch = parseBotPatch((req.body ?? {}) as Record<string, unknown>);
    const updated = bot.updateConfig(patch);
    journal.write('info', null, 'Strategy settings updated');
    res.json({ config: updated, stats: bot.stats() });
  });

  router.post('/bot/start', (_req, res) => {
    bot.start();
    res.json({ config: bot.config, stats: bot.stats() });
  });

  router.post('/bot/stop', (req, res) => {
    const flatten = asBoolean((req.body ?? {}).closePositions) ?? false;
    bot.stop(flatten);
    res.json({ config: bot.config, stats: bot.stats() });
  });

  router.get('/recoveries', (_req, res) => res.json(bot.listRecoveries()));

  router.get('/logs', (_req, res) => res.json(journal.list()));

  return router;
}
