import { barStart, type Bar } from '@sentinal/mql5';
import type { TradingAccount } from '../broker/account.js';
import type { HistoryProvider } from '../engine/expert.js';
import type { MarketFeed } from './feed.js';

/**
 * History from the terminal's own feed, for demo mode and paper trading:
 * the feed's one-minute bars rolled up into whatever timeframe the expert
 * asks for, stamped in the account's server time.
 */
export class FeedHistoryProvider implements HistoryProvider {
  constructor(private readonly feed: MarketFeed) {}

  async loadBars(account: TradingAccount, _symbol: string, timeframe: number, count: number): Promise<Bar[]> {
    const bars: Bar[] = [];
    let current: Bar | null = null;
    const point = account.spec().point ?? account.spec().tickSize;
    const spread = Math.round((account.spec().baseSpread || 0) / (point || 1));
    for (const candle of this.feed.candles) {
      const time = barStart(Math.floor(candle.time / 1000) + account.serverOffset, timeframe);
      if (!current || current.time !== time) {
        if (current) bars.push(current);
        current = { time, open: candle.open, high: candle.high, low: candle.low, close: candle.close, tickVolume: candle.volume, spread, realVolume: 0 };
      } else {
        current.high = Math.max(current.high, candle.high);
        current.low = Math.min(current.low, candle.low);
        current.close = candle.close;
        current.tickVolume += candle.volume;
      }
    }
    if (current) bars.push(current);
    return bars.slice(-count);
  }
}
