import type { Position, Side, SymbolSpec } from './types.js';

/** XAUUSD contract: 100 troy oz per lot, so a $1 move is $100 per standard lot. */
export const XAUUSD: SymbolSpec = {
  symbol: 'XAUUSD',
  digits: 2,
  tickSize: 0.01,
  contractSize: 100,
  minLot: 0.01,
  maxLot: 50,
  lotStep: 0.01,
  baseSpread: 0.22,
  commissionPerLot: 7,
};

export const SYMBOLS: Record<string, SymbolSpec> = { XAUUSD };

/**
 * Registers the contract specification a broker reports for a symbol.
 *
 * Brokers differ on contract size, digits and the lot grid, and they name gold
 * differently (XAUUSD, GOLD, XAUUSD.m …). Registering the real specification
 * keeps profit, stop distances and margin correct instead of assuming the
 * built-in defaults.
 */
export function registerSymbolSpec(spec: SymbolSpec): void {
  SYMBOLS[spec.symbol] = spec;
}

export function getSymbolSpec(symbol: string): SymbolSpec {
  return SYMBOLS[symbol] ?? XAUUSD;
}

/** Money value of a one-unit price move for the given volume. */
export function valuePerPricePoint(spec: SymbolSpec, volume: number): number {
  return spec.contractSize * volume;
}

/** Convert a money target into a price distance for the given volume. */
export function usdToPriceDistance(spec: SymbolSpec, volume: number, usd: number): number {
  const perPoint = valuePerPricePoint(spec, volume);
  if (perPoint <= 0) return 0;
  return usd / perPoint;
}

/** Convert a price distance into a money amount for the given volume. */
export function priceDistanceToUsd(spec: SymbolSpec, volume: number, distance: number): number {
  return distance * valuePerPricePoint(spec, volume);
}

export function roundLot(spec: SymbolSpec, volume: number): number {
  const steps = Math.round(volume / spec.lotStep);
  const rounded = steps * spec.lotStep;
  return Number(Math.min(spec.maxLot, Math.max(spec.minLot, rounded)).toFixed(2));
}

export function roundPrice(spec: SymbolSpec, price: number): number {
  return Number(price.toFixed(spec.digits));
}

/** Price a position is valued at: sells are closed at the ask, buys at the bid. */
export function exitPrice(side: Side, bid: number, ask: number): number {
  return side === 'buy' ? bid : ask;
}

export function entryPrice(side: Side, bid: number, ask: number): number {
  return side === 'buy' ? ask : bid;
}

export function grossProfit(
  spec: SymbolSpec,
  side: Side,
  volume: number,
  openPrice: number,
  closePrice: number,
): number {
  const diff = side === 'buy' ? closePrice - openPrice : openPrice - closePrice;
  return diff * valuePerPricePoint(spec, volume);
}

export function commissionFor(spec: SymbolSpec, volume: number): number {
  return spec.commissionPerLot * volume;
}

/** Floating result of a position including costs already paid. */
export function positionProfit(spec: SymbolSpec, position: Position, bid: number, ask: number): number {
  const price = exitPrice(position.side, bid, ask);
  return grossProfit(spec, position.side, position.volume, position.openPrice, price) + position.swap;
}

export function stopLevels(
  spec: SymbolSpec,
  side: Side,
  volume: number,
  openPrice: number,
  stopLossUsd: number | null,
  takeProfitUsd: number | null,
): { stopLoss: number | null; takeProfit: number | null } {
  const slDistance = stopLossUsd ? usdToPriceDistance(spec, volume, stopLossUsd) : null;
  const tpDistance = takeProfitUsd ? usdToPriceDistance(spec, volume, takeProfitUsd) : null;
  const dir = side === 'buy' ? 1 : -1;
  return {
    stopLoss: slDistance === null ? null : roundPrice(spec, openPrice - dir * slDistance),
    takeProfit: tpDistance === null ? null : roundPrice(spec, openPrice + dir * tpDistance),
  };
}

/** Margin required for a position, account currency, at the given leverage. */
export function marginRequired(
  spec: SymbolSpec,
  volume: number,
  price: number,
  leverage: number,
): number {
  return (spec.contractSize * volume * price) / Math.max(1, leverage);
}

export function formatMoney(value: number, currency = 'USD'): string {
  const sign = value < 0 ? '-' : '';
  const abs = Math.abs(value);
  const symbol = currency === 'USD' ? '$' : '';
  return `${sign}${symbol}${abs.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export function formatPrice(value: number, digits = 2): string {
  return value.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function formatVolume(volume: number): string {
  return volume.toFixed(2);
}
