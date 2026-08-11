import {
  getSymbolSpec,
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

  const symbol = input.symbol?.toUpperCase() || runtime.bot.config.symbol;
  const spec = getSymbolSpec(symbol);
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
  const trade = await account.submitClose(id, 'manual');
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
    closed += account.closeAll('manual', (p) => {
      if (input.side && p.side !== input.side) return false;
      if (input.profitableOnly && p.profit <= 0) return false;
      return true;
    }).length;
  }
  runtime.journal.write('warn', input.accountId ?? null, `Bulk close executed — ${closed} position(s)`);
  return { closed };
}

export function modifyPosition(
  runtime: Runtime,
  id: string,
  stopLoss: number | null,
  takeProfit: number | null,
): Position {
  const account = runtime.accounts.list().find((a) => a.getPosition(id));
  if (!account) throw new CommandError('position not found', 404);
  account.modify(id, stopLoss, takeProfit);
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
