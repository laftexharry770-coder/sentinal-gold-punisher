import {
  getSymbolSpec,
  roundLot,
  type ClosedTrade,
  type CopySettings,
  type Position,
  type Side,
} from '@sentinal/shared';
import type { TradingAccount } from '../broker/account.js';
import type { AccountManager } from '../broker/manager.js';
import type { Journal } from '../journal.js';

/**
 * Master → slave replication.
 *
 * Every leg the master opens (bot, manual or recovery) is mirrored onto each
 * follower with its own sizing rule, so a burst of eight legs on the master
 * becomes eight legs on every follower.
 */
export class CopyTradeEngine {
  /** master position id -> [{ accountId, positionId }] */
  private links = new Map<string, { accountId: string; positionId: string }[]>();

  constructor(
    private readonly accounts: AccountManager,
    private readonly journal: Journal,
  ) {
    this.accounts.on('opened', (position: Position, account: TradingAccount) => {
      void this.onMasterOpen(position, account);
    });
    this.accounts.on('closed', (trade: ClosedTrade, position: Position, account: TradingAccount) => {
      void this.onMasterClose(trade, position, account);
    });
  }

  private resolveVolume(settings: CopySettings, master: TradingAccount, slave: TradingAccount, volume: number): number {
    const spec = getSymbolSpec('XAUUSD');
    let target: number;
    switch (settings.sizing) {
      case 'fixed':
        target = settings.fixedLot;
        break;
      case 'balance-ratio': {
        const ratio = master.balance > 0 ? slave.balance / master.balance : 1;
        target = volume * ratio;
        break;
      }
      default:
        target = volume * settings.multiplier;
    }
    const bounded = Math.min(settings.maxLot, Math.max(settings.minLot, target));
    return roundLot(spec, bounded);
  }

  private async onMasterOpen(position: Position, master: TradingAccount): Promise<void> {
    if (position.origin === 'copy') return;
    const followers = this.accounts.slavesOf(master.id);
    if (followers.length === 0) return;

    for (const slave of followers) {
      const settings = slave.config.copy;
      if (settings.symbolWhitelist.length > 0 && !settings.symbolWhitelist.includes(position.symbol)) {
        continue;
      }

      const side: Side = settings.reverse
        ? position.side === 'buy'
          ? 'sell'
          : 'buy'
        : position.side;
      const volume = this.resolveVolume(settings, master, slave, position.volume);

      const result = await slave.submit({
        symbol: position.symbol,
        side,
        volume,
        stopLossUsd: settings.copyStopLoss ? position.stopLossUsd : null,
        takeProfitUsd: settings.copyTakeProfit ? position.takeProfitUsd : null,
        origin: 'copy',
        comment: `copy#${position.ticket}`,
        basketIndex: position.basketIndex,
        recoveryLayer: position.recoveryLayer,
        sourceId: position.id,
        magic: position.magic,
      });

      if (!result.ok) {
        this.journal.write('warn', slave.id, `Copy rejected from ${master.config.name}: ${result.error}`);
        continue;
      }

      const slippage = Math.abs(result.position.openPrice - position.openPrice);
      if (settings.maxSlippage > 0 && slippage > settings.maxSlippage) {
        await slave.submitClose(result.position.id, 'copy');
        this.journal.write(
          'warn',
          slave.id,
          `Copy cancelled — slippage ${slippage.toFixed(2)} exceeded limit ${settings.maxSlippage.toFixed(2)}`,
        );
        continue;
      }

      const links = this.links.get(position.id) ?? [];
      links.push({ accountId: slave.id, positionId: result.position.id });
      this.links.set(position.id, links);

      this.journal.write(
        'copy',
        slave.id,
        `Mirrored ${side.toUpperCase()} ${volume.toFixed(2)} ${position.symbol} @ ${result.position.openPrice.toFixed(2)} from ${master.config.name}`,
      );
    }
  }

  private async onMasterClose(trade: ClosedTrade, position: Position, master: TradingAccount): Promise<void> {
    const links = this.links.get(position.id);
    if (!links) return;
    this.links.delete(position.id);

    for (const link of links) {
      const slave = this.accounts.get(link.accountId);
      if (!slave || !slave.config.copy.copyCloses) continue;
      const closed = await slave.submitClose(link.positionId, 'copy');
      if (closed) {
        this.journal.write(
          'copy',
          slave.id,
          `Closed mirrored #${closed.ticket} following ${master.config.name} (${closed.netProfit >= 0 ? '+' : ''}${closed.netProfit.toFixed(2)})`,
        );
      }
    }
  }
}
