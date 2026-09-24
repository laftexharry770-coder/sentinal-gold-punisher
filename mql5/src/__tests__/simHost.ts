import type {
  ExpertHost,
  HostAccount,
  HostDeal,
  HostOrder,
  HostPosition,
  HostQuote,
  HostSymbolSpec,
  LogLevel,
  TradeRequest,
  TradeResult,
} from '../runtime/host.js';
import { MarketData, type Bar } from '../runtime/series.js';

/** A small hedging broker for tests: fills at the quote, honours stops, books deals. */
export class SimHost implements ExpertHost {
  readonly market = new MarketData();
  readonly logs: { level: LogLevel; message: string }[] = [];
  readonly requests: TradeRequest[] = [];
  commentText = '';
  allowTrading = true;
  private q: HostQuote;
  private readonly pos: HostPosition[] = [];
  private readonly pending: HostOrder[] = [];
  private readonly dealList: HostDeal[] = [];
  private ticket = 1000;
  balance = 10_000;

  readonly specs: Record<string, HostSymbolSpec> = {
    XAUUSD: {
      name: 'XAUUSD',
      description: 'Gold vs US Dollar',
      digits: 2,
      point: 0.01,
      tickSize: 0.01,
      tickValue: 1,
      tickValueProfit: 1,
      tickValueLoss: 1,
      contractSize: 100,
      volumeMin: 0.01,
      volumeMax: 100,
      volumeStep: 0.01,
      volumeLimit: 0,
      stopsLevel: 0,
      freezeLevel: 0,
      tradeMode: 4,
      fillingFlags: 1,
      executionMode: 2,
      calcMode: 4,
      orderMode: 127,
      swapLong: 0,
      swapShort: 0,
      marginInitial: 0,
      marginMaintenance: 0,
      currencyBase: 'XAU',
      currencyProfit: 'USD',
      currencyMargin: 'XAU',
      path: 'Metals\\XAUUSD',
    },
  };

  constructor(
    readonly symbol = 'XAUUSD',
    readonly timeframe = 1,
    start = 1_758_700_000,
    price = 3300,
  ) {
    this.q = { bid: price, ask: price + 0.2, last: price, time: start, timeMsc: start * 1000, volume: 1 };
  }

  seedBars(timeframe: number, bars: Bar[]): void {
    this.market.seed(this.symbol, timeframe, bars);
  }

  /** Moves the market and executes stops, like a broker server would. */
  quoteAt(bid: number, time: number, spread = 0.2): void {
    this.q = { bid, ask: +(bid + spread).toFixed(2), last: bid, time, timeMsc: time * 1000, volume: 1 };
    this.market.onQuote(this.symbol, this.q.bid, this.q.ask, time, 0.01);
    for (const p of [...this.pos]) {
      const exit = p.type === 0 ? this.q.bid : this.q.ask;
      p.priceCurrent = exit;
      p.profit = +((p.type === 0 ? exit - p.priceOpen : p.priceOpen - exit) * 100 * p.volume).toFixed(2);
      if (p.sl > 0 && (p.type === 0 ? exit <= p.sl : exit >= p.sl)) this.closePosition(p, p.sl, 4);
      else if (p.tp > 0 && (p.type === 0 ? exit >= p.tp : exit <= p.tp)) this.closePosition(p, p.tp, 5);
    }
  }

  private closePosition(p: HostPosition, price: number, reason: number, volume = p.volume): number {
    const profit = +((p.type === 0 ? price - p.priceOpen : p.priceOpen - price) * 100 * volume).toFixed(2);
    this.balance = +(this.balance + profit).toFixed(2);
    const ticket = ++this.ticket;
    this.dealList.push({
      ticket,
      order: ticket,
      time: this.q.time,
      timeMsc: this.q.timeMsc,
      type: p.type === 0 ? 1 : 0,
      entry: 1,
      magic: p.magic,
      reason,
      positionId: p.identifier,
      volume,
      price,
      commission: 0,
      swap: 0,
      profit,
      fee: 0,
      sl: p.sl,
      tp: p.tp,
      symbol: p.symbol,
      comment: reason === 4 ? '[sl]' : reason === 5 ? '[tp]' : '',
      externalId: '',
    });
    if (volume >= p.volume - 1e-9) this.pos.splice(this.pos.indexOf(p), 1);
    else p.volume = +(p.volume - volume).toFixed(2);
    return ticket;
  }

  symbols(): string[] {
    return Object.keys(this.specs);
  }
  spec(symbol: string): HostSymbolSpec | null {
    return this.specs[symbol] ?? null;
  }
  quote(symbol: string): HostQuote | null {
    return symbol === this.symbol ? this.q : null;
  }
  serverTime(): number {
    return this.q.time;
  }
  serverOffset(): number {
    return 0;
  }
  account(): HostAccount {
    const floating = this.pos.reduce((s, p) => s + p.profit, 0);
    const margin = this.pos.reduce((s, p) => s + (p.volume * 100 * p.priceOpen) / 500, 0);
    const equity = this.balance + floating;
    return {
      login: 12345678,
      name: 'Test',
      server: 'Sim-Server',
      company: 'Sim Broker',
      currency: 'USD',
      balance: this.balance,
      credit: 0,
      equity,
      profit: floating,
      margin,
      freeMargin: equity - margin,
      marginLevel: margin > 0 ? (equity / margin) * 100 : 0,
      leverage: 500,
      tradeMode: 0,
      marginMode: 2,
      marginSoCall: 50,
      marginSoSo: 30,
      marginSoMode: 0,
      limitOrders: 200,
      currencyDigits: 2,
    };
  }
  connected(): boolean {
    return true;
  }
  tradeAllowed(): boolean {
    return this.allowTrading;
  }
  positions(): HostPosition[] {
    return this.pos;
  }
  orders(): HostOrder[] {
    return this.pending;
  }
  deals(from: number, to: number): HostDeal[] {
    return this.dealList.filter((d) => d.time >= from && d.time <= to);
  }
  historyOrders(): HostOrder[] {
    return [];
  }

  async orderSend(req: TradeRequest): Promise<TradeResult> {
    this.requests.push(req);
    const base = { deal: 0, order: 0, volume: req.volume, price: 0, bid: this.q.bid, ask: this.q.ask, comment: '', requestId: 0, retcodeExternal: 0 };
    if (req.action === 1) {
      if (req.position > 0) {
        const p = this.pos.find((x) => x.ticket === req.position);
        if (!p) return { ...base, retcode: 10036, comment: 'position closed' };
        const price = p.type === 0 ? this.q.bid : this.q.ask;
        const deal = this.closePosition(p, price, 3, req.volume);
        return { ...base, retcode: 10009, deal, order: deal, price };
      }
      const price = req.type === 0 ? this.q.ask : this.q.bid;
      const ticket = ++this.ticket;
      this.pos.push({
        ticket,
        identifier: ticket,
        symbol: req.symbol,
        type: req.type,
        volume: req.volume,
        priceOpen: price,
        priceCurrent: price,
        sl: req.sl,
        tp: req.tp,
        profit: 0,
        swap: 0,
        commission: 0,
        magic: req.magic,
        comment: req.comment,
        externalId: '',
        time: this.q.time,
        timeMsc: this.q.timeMsc,
        timeUpdate: this.q.time,
        reason: 3,
      });
      this.dealList.push({
        ticket,
        order: ticket,
        time: this.q.time,
        timeMsc: this.q.timeMsc,
        type: req.type,
        entry: 0,
        magic: req.magic,
        reason: 3,
        positionId: ticket,
        volume: req.volume,
        price,
        commission: 0,
        swap: 0,
        profit: 0,
        fee: 0,
        sl: req.sl,
        tp: req.tp,
        symbol: req.symbol,
        comment: req.comment,
        externalId: '',
      });
      return { ...base, retcode: 10009, deal: ticket, order: ticket, price };
    }
    if (req.action === 6) {
      const p = this.pos.find((x) => x.ticket === req.position);
      if (!p) return { ...base, retcode: 10036 };
      p.sl = req.sl;
      p.tp = req.tp;
      return { ...base, retcode: 10009 };
    }
    return { ...base, retcode: 10013, comment: 'unsupported in sim' };
  }

  log(level: LogLevel, message: string): void {
    this.logs.push({ level, message });
  }
  comment(text: string): void {
    this.commentText = text;
  }
}

/** A deterministic random walk of M1 bars ending just before `end`. */
export function makeBars(count: number, end: number, start = 3300, seed = 7): Bar[] {
  let s = seed;
  const rnd = () => {
    s = (s * 1103515245 + 12345) >>> 0;
    return s / 4294967296;
  };
  const bars: Bar[] = [];
  let price = start;
  for (let i = count; i > 0; i -= 1) {
    const time = end - i * 60;
    const open = price;
    let high = open;
    let low = open;
    for (let k = 0; k < 6; k += 1) {
      price += (rnd() - 0.5) * 1.2;
      high = Math.max(high, price);
      low = Math.min(low, price);
    }
    bars.push({ time: time - (time % 60), open: +open.toFixed(2), high: +high.toFixed(2), low: +low.toFixed(2), close: +price.toFixed(2), tickVolume: 50, spread: 20, realVolume: 0 });
  }
  return bars;
}
