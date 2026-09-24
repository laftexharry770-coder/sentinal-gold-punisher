import {
  roundLot,
  type AccountConfig,
  type AccountState,
  type BotConfig,
  type BotStats,
  type ClosedTrade,
  type CopySettings,
  type Position,
  type Side,
} from '@sentinal/shared';
import type { AddedExpert, StrategyFile } from './engine/bank.js';
import type { NewAccountInput } from './broker/manager.js';
import type { Runtime } from './runtime.js';

/** Rejection carrying the status an HTTP caller should surface. */
export class CommandError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = 'CommandError';
    this.status = status;
  }
}

export interface OrderInput {
  accountId?: string;
  symbol?: string;
  side: Side;
  volume?: number;
  /** Legs fired in one ticket — the manual multi-entry control. */
  legs?: number;
  stopLossUsd?: number | null;
  takeProfitUsd?: number | null;
  comment?: string;
}

export interface CloseAllInput {
  accountId?: string;
  side?: Side;
  profitableOnly?: boolean;
}

export interface BotView {
  config: BotConfig;
  stats: BotStats;
}

/**
 * Every state-changing operation the terminal can perform, independent of
 * transport. The HTTP routes and the in-browser build both call these, so the
 * two builds cannot drift apart in behaviour or in what they journal.
 */

export function addAccount(runtime: Runtime, input: NewAccountInput): AccountState {
  if (!input.name?.trim() || !input.login?.trim() || !input.server?.trim()) {
    throw new CommandError('name, login and server are required');
  }
  const account = runtime.accounts.add(input);
  runtime.journal.write(
    'success',
    account.id,
    `Linked ${account.config.name} (${account.config.provider}) on ${account.config.server}`,
  );
  return account.state();
}

export function updateAccount(
  runtime: Runtime,
  id: string,
  patch: { name?: string; role?: AccountConfig['role']; copy?: Partial<CopySettings> },
): AccountState {
  const account = runtime.accounts.update(id, patch as Partial<AccountConfig>);
  if (!account) throw new CommandError('account not found', 404);
  return account.state();
}

export function removeAccount(runtime: Runtime, id: string): { ok: true } {
  const account = runtime.accounts.get(id);
  if (!account) throw new CommandError('account not found', 404);
  const name = account.config.name;
  runtime.accounts.remove(id);
  runtime.journal.write('warn', null, `Unlinked ${name}`);
  return { ok: true };
}

export async function placeOrder(
  runtime: Runtime,
  input: OrderInput,
): Promise<{ opened: Position[]; errors: string[] }> {
  const accountId = input.accountId ?? runtime.accounts.primary()?.id;
  if (!accountId) throw new CommandError('no account available');
  const account = runtime.accounts.get(accountId);
  if (!account) throw new CommandError('account not found', 404);
  if (input.side !== 'buy' && input.side !== 'sell') throw new CommandError('side must be buy or sell');

  // Broker symbol names are case-sensitive (Exness trades XAUUSDm), so a typed
  // name is matched to the account's own rather than upper-cased.
  const typed = input.symbol?.trim();
  const symbol = !typed || typed.toUpperCase() === account.symbol.toUpperCase() ? account.symbol : typed;
  const spec = account.spec(symbol);
  const volume = roundLot(spec, input.volume ?? runtime.bot.config.lotSize);
  const legs = Math.max(1, Math.min(50, Math.round(input.legs ?? 1)));

  const result = await runtime.bot.manualOrder(account, {
    symbol,
    side: input.side,
    volume,
    legs,
    stopLossUsd: input.stopLossUsd === undefined ? runtime.bot.config.stopLossUsd : input.stopLossUsd,
    takeProfitUsd:
      input.takeProfitUsd === undefined ? runtime.bot.config.takeProfitUsd : input.takeProfitUsd,
    comment: input.comment,
  });

  if (result.opened.length === 0) {
    throw new CommandError(result.errors[0] ?? 'order rejected', 422);
  }
  return result;
}

export async function closePosition(runtime: Runtime, id: string): Promise<ClosedTrade> {
  const account = runtime.accounts.list().find((a) => a.getPosition(id));
  if (!account) throw new CommandError('position not found', 404);
  // A master's close goes out with its copies' closes in the same instant.
  const trade =
    account.config.role === 'master'
      ? await runtime.copier.close(account, id, 'manual')
      : await account.submitClose(id, 'manual');
  if (!trade) throw new CommandError('close rejected by broker', 422);
  runtime.journal.write(
    'trade',
    account.id,
    `Closed #${trade.ticket} manually (${trade.netProfit >= 0 ? '+' : ''}${trade.netProfit.toFixed(2)})`,
  );
  return trade;
}

export function closeAll(runtime: Runtime, input: CloseAllInput): { closed: number } {
  const targets = input.accountId
    ? [runtime.accounts.get(input.accountId)].filter((a) => a !== undefined)
    : runtime.accounts.list();

  let closed = 0;
  for (const account of targets) {
    closed += account.requestCloseAll('manual', (p) => {
      if (input.side && p.side !== input.side) return false;
      if (input.profitableOnly && p.profit <= 0) return false;
      return true;
    });
  }
  runtime.journal.write('warn', input.accountId ?? null, `Bulk close sent — ${closed} position(s)`);
  return { closed };
}

export async function modifyPosition(
  runtime: Runtime,
  id: string,
  stopLoss: number | null,
  takeProfit: number | null,
): Promise<Position> {
  const account = runtime.accounts.list().find((a) => a.getPosition(id));
  if (!account) throw new CommandError('position not found', 404);
  const result =
    account.config.role === 'master'
      ? await runtime.copier.modify(account, id, stopLoss, takeProfit)
      : await account.submitModify(id, stopLoss, takeProfit);
  if (!result.ok) throw new CommandError(`modify rejected: ${result.error}`, 422);
  return account.getPosition(id) as Position;
}

export function updateBotConfig(runtime: Runtime, patch: Partial<BotConfig>): BotView {
  const config = runtime.bot.updateConfig(patch);
  runtime.journal.write('info', null, 'Strategy settings updated');
  return { config, stats: runtime.bot.stats() };
}

export function startBot(runtime: Runtime): BotView {
  runtime.bot.start();
  return { config: runtime.bot.config, stats: runtime.bot.stats() };
}

export function stopBot(runtime: Runtime, closePositions = false): BotView {
  runtime.bot.stop(closePositions);
  return { config: runtime.bot.config, stats: runtime.bot.stats() };
}

/* ------------------------------------------------------------------ */
/* Strategy: the built-in model and the EA library                      */
/* ------------------------------------------------------------------ */

export type { AddedExpert, LoadStrategyResult, StrategyFile } from './engine/bank.js';

/**
 * Adds uploaded files to the EA library. Each .mq5 (with any .mqh headers
 * it includes) becomes an EA of its own and each .ex5 a mirrored one;
 * several can be added at once, and any number kept. New EAs are switched
 * on unless asked otherwise, and start at once if the bot is running.
 */
export async function addExperts(
  runtime: Runtime,
  files: StrategyFile[],
  options: { enabled?: boolean; inputs?: Record<string, string | number | boolean>; timeframe?: number; bundled?: boolean } = {},
): Promise<AddedExpert[]> {
  if (!files.some((f) => /\.(mq5|ex5)$/i.test(f.name))) {
    throw new CommandError('Choose one or more .mq5 or .ex5 files (headers alone are not an EA).');
  }
  const added = await runtime.experts.add(files, options);
  const master = runtime.accounts.primary();
  if (runtime.bot.stats().running && master) {
    for (const a of added) if (a.id && (options.enabled ?? true)) await runtime.experts.setEnabled(a.id, true, master);
  }
  return added;
}

export async function removeExpert(runtime: Runtime, id: string): Promise<{ ok: true }> {
  if (!(await runtime.experts.remove(id))) throw new CommandError('EA not found', 404);
  return { ok: true };
}

/** Switches an EA on or off; with the bot running it starts or stops at once. */
export async function setExpertEnabled(runtime: Runtime, id: string, enabled: boolean): Promise<{ ok: true }> {
  const master = runtime.bot.stats().running ? runtime.accounts.primary() ?? null : null;
  if (!(await runtime.experts.setEnabled(id, enabled, master))) throw new CommandError('EA not found', 404);
  return { ok: true };
}

/**
 * New input values or chart timeframe for one EA. A running EA is
 * re-initialised with them, the way MetaTrader restarts an EA whose inputs
 * change (OnDeinit with REASON_PARAMETERS, then OnInit).
 */
export async function configureExpert(
  runtime: Runtime,
  id: string,
  patch: { inputs?: Record<string, string | number | boolean>; timeframe?: number },
): Promise<{ ok: true }> {
  const master = runtime.bot.stats().running ? runtime.accounts.primary() ?? null : null;
  if (!(await runtime.experts.configure(id, patch, master))) throw new CommandError('EA not found', 404);
  return { ok: true };
}

/** Picks the built-in model that trades beside the EAs — or 'none' for the EAs alone. */
export function useBuiltinStrategy(runtime: Runtime, strategy: BotConfig['strategy']): BotView {
  runtime.bot.updateConfig({ strategy });
  runtime.journal.write('info', null, strategy === 'none' ? 'Built-in model off — the EAs switched on trade alone' : `Built-in model: ${strategy}`);
  return { config: runtime.bot.config, stats: runtime.bot.stats() };
}
