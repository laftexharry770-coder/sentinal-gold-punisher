import type {
  MetaApiClient,
  MtAccount,
  MtAccountInformation,
  MtCandle,
  MtConnection,
  MtDeal,
  MtOrder,
  MtPosition,
  MtPrice,
  MtSpecification,
  MtStop,
  MtTradeOptions,
  MtTradeResponse,
} from '../broker/metaapi.js';

/*
 * An in-memory stand-in for MetaApi's SDK: accounts, a streaming connection
 * with a MetaTrader book behind it, and the REST account list. Shared by the
 * engine's adapter tests and the web backend's connect-flow tests.
 */

export const settle = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

/** Server time three hours ahead of UTC, as most gold brokers run. */
export const OFFSET_MS = 3 * 3600_000;
export function brokerTime(utcMs: number): string {
  return new Date(utcMs + OFFSET_MS).toISOString().replace('T', ' ').replace('Z', '');
}

type Listener = Record<string, (...args: unknown[]) => Promise<unknown>>;

interface SentOrder {
  kind: string;
  symbol: string;
  volume: number;
  stopLoss: MtStop;
  takeProfit: MtStop;
  options: MtTradeOptions;
  at: number;
}

/**
 * A MetaApi streaming connection over an in-memory MetaTrader account.
 * Events reach listeners in the order MetaApi's websocket client sends them:
 * account information, positions, orders, then deals.
 */
export class FakeConnection implements MtConnection {
  listeners: Listener[] = [];
  sent: SentOrder[] = [];
  closes: { positionId: string; volume?: number; at: number }[] = [];
  modifies: { positionId: string; stopLoss: MtStop; takeProfit: MtStop }[] = [];
  /** Broker round trip, ms. */
  latencyMs = 0;
  /** Report the fill on the stream before (true) or after (false) answering. */
  streamFirst = true;
  rejectWith: { message: string; stringCode: string } | null = null;
  subscribed: string[] = [];
  private ticket: number;
  private dealSeq = 900_000;

  readonly terminalState: FakeConnection['state'];
  readonly historyStorage: { deals: MtDeal[] } = { deals: [] };

  state: {
    connected: boolean;
    connectedToBroker: boolean;
    accountInformation: MtAccountInformation;
    positions: MtPosition[];
    orders: MtOrder[];
    specifications: MtSpecification[];
    prices: Map<string, MtPrice>;
    specification(symbol: string): MtSpecification | undefined;
    price(symbol: string): MtPrice | undefined;
  };

  constructor(opts: { symbol: string; balance: number; firstTicket: number; positions?: MtPosition[] }) {
    this.ticket = opts.firstTicket;
    const specs: MtSpecification[] = [
      { symbol: 'EURUSDm', tickSize: 0.00001, minVolume: 0.01, maxVolume: 200, volumeStep: 0.01, contractSize: 100_000, digits: 5, point: 0.00001 },
      {
        symbol: opts.symbol,
        tickSize: 0.001,
        minVolume: 0.01,
        maxVolume: 200,
        volumeStep: 0.01,
        contractSize: 100,
        digits: 3,
        point: 0.001,
        fillingModes: ['SYMBOL_FILLING_FOK', 'SYMBOL_FILLING_IOC'],
        tradeMode: 'SYMBOL_TRADE_MODE_FULL',
        stopsLevel: 0,
        freezeLevel: 0,
        description: 'Gold vs US Dollar',
      },
    ];
    const prices = new Map<string, MtPrice>();
    this.state = {
      connected: true,
      connectedToBroker: true,
      accountInformation: {
        platform: 'mt5',
        broker: 'Exness Technologies Ltd',
        currency: 'USD',
        server: 'Exness-MT5Trial9',
        balance: opts.balance,
        equity: opts.balance,
        margin: 0,
        freeMargin: opts.balance,
        leverage: 2000,
        marginLevel: 0,
        tradeAllowed: true,
        name: 'Test',
        login: 12345,
        type: 'ACCOUNT_TRADE_MODE_DEMO',
      },
      positions: opts.positions ?? [],
      orders: [],
      specifications: specs,
      prices,
      specification: (symbol) => specs.find((s) => s.symbol === symbol),
      price: (symbol) => prices.get(symbol),
    };
    this.terminalState = this.state;
  }

  async connect(): Promise<void> {}
  async waitSynchronized(): Promise<void> {}
  async subscribeToMarketData(symbol: string): Promise<void> {
    this.subscribed.push(symbol);
  }
  addSynchronizationListener(listener: never): void {
    this.listeners.push(listener as unknown as Listener);
  }
  removeSynchronizationListener(listener: never): void {
    this.listeners = this.listeners.filter((l) => l !== (listener as unknown as Listener));
  }
  async close(): Promise<void> {}

  private async fire(method: string, ...args: unknown[]): Promise<void> {
    for (const listener of this.listeners) await listener[method]!('vint-hill:0:ps-mpa-1', ...args);
  }

  /** A quote from the broker. */
  async quote(symbol: string, bid: number, ask: number, utcMs = Date.now()): Promise<void> {
    const price: MtPrice = { symbol, bid, ask, profitTickValue: 0.1, lossTickValue: 0.1, time: new Date(utcMs), brokerTime: brokerTime(utcMs) };
    this.state.prices.set(symbol, price);
    for (const p of this.state.positions) {
      if (p.symbol !== symbol) continue;
      p.currentPrice = p.type === 'POSITION_TYPE_BUY' ? bid : ask;
      p.profit = Math.round((p.type === 'POSITION_TYPE_BUY' ? bid - p.openPrice : p.openPrice - ask) * p.volume * 100 * 100) / 100;
    }
    await this.fire('onSymbolPriceUpdated', price);
    await this.fire('onSymbolPricesUpdated', [price], this.state.accountInformation.equity, 0, this.state.accountInformation.freeMargin, 0);
  }

  private deal(p: MtPosition, entry: string, volume: number, price: number, profit: number, reason: string): MtDeal {
    const deal: MtDeal = {
      id: String(++this.dealSeq),
      type: (entry === 'DEAL_ENTRY_IN') === (p.type === 'POSITION_TYPE_BUY') ? 'DEAL_TYPE_BUY' : 'DEAL_TYPE_SELL',
      entryType: entry,
      symbol: p.symbol,
      magic: p.magic,
      time: new Date(),
      volume,
      price,
      commission: -0.07 * (volume / 0.01) / 2,
      swap: 0,
      profit,
      positionId: String(p.id),
      orderId: String(p.id),
      comment: p.comment,
      clientId: p.clientId,
      reason,
    };
    this.historyStorage.deals.push(deal);
    return deal;
  }

  /** Opens a position the way MetaTrader reports it. */
  async openAtBroker(input: { side: 'buy' | 'sell'; volume: number; symbol: string; sl?: number; tp?: number; clientId?: string; comment?: string; magic?: number; reason?: string }): Promise<MtPosition> {
    const price = this.state.prices.get(input.symbol);
    const openPrice = input.side === 'buy' ? price?.ask ?? 3300 : price?.bid ?? 3300;
    const p: MtPosition = {
      id: ++this.ticket,
      type: input.side === 'buy' ? 'POSITION_TYPE_BUY' : 'POSITION_TYPE_SELL',
      symbol: input.symbol,
      magic: input.magic ?? 0,
      time: new Date(),
      brokerTime: brokerTime(Date.now()),
      openPrice,
      currentPrice: openPrice,
      stopLoss: input.sl,
      takeProfit: input.tp,
      volume: input.volume,
      swap: 0,
      profit: 0,
      commission: -0.035 * (input.volume / 0.01),
      comment: input.comment,
      clientId: input.clientId,
    };
    this.state.positions.push(p);
    const deal = this.deal(p, 'DEAL_ENTRY_IN', input.volume, openPrice, 0, input.reason ?? 'DEAL_REASON_EXPERT');
    await this.fire('onPositionsUpdated', [p], []);
    await this.fire('onPositionUpdated', p);
    await this.fire('onDealAdded', deal);
    return p;
  }

  /** Closes all or part of a position the way MetaTrader reports it. */
  async closeAtBroker(positionId: string, reason = 'DEAL_REASON_CLIENT', volume?: number): Promise<void> {
    const p = this.state.positions.find((x) => String(x.id) === positionId);
    if (!p) throw Object.assign(new Error('Position not found'), { stringCode: 'TRADE_RETCODE_POSITION_CLOSED' });
    const price = this.state.prices.get(p.symbol);
    const exit = p.type === 'POSITION_TYPE_BUY' ? price?.bid ?? p.openPrice : price?.ask ?? p.openPrice;
    const closing = volume ?? p.volume;
    const profit = Math.round((p.type === 'POSITION_TYPE_BUY' ? exit - p.openPrice : p.openPrice - exit) * closing * 100 * 100) / 100;
    const info = this.state.accountInformation;
    info.balance = Math.round((info.balance + profit) * 100) / 100;
    await this.fire('onAccountInformationUpdated', { ...info });
    const deal = this.deal(p, 'DEAL_ENTRY_OUT', closing, exit, profit, reason);
    if (volume !== undefined && volume < p.volume) {
      p.volume = Math.round((p.volume - volume) * 100) / 100;
      await this.fire('onPositionsUpdated', [p], []);
      await this.fire('onPositionUpdated', p);
    } else {
      this.state.positions = this.state.positions.filter((x) => x !== p);
      await this.fire('onPositionsUpdated', [], [positionId]);
      await this.fire('onPositionRemoved', positionId);
    }
    await this.fire('onDealAdded', deal);
  }

  private async trade(kind: string, symbol: string, volume: number, stopLoss: MtStop, takeProfit: MtStop, options: MtTradeOptions = {}): Promise<MtTradeResponse> {
    this.sent.push({ kind, symbol, volume, stopLoss, takeProfit, options, at: performance.now() });
    await settle(this.latencyMs);
    if (this.rejectWith) throw Object.assign(new Error(this.rejectWith.message), { stringCode: this.rejectWith.stringCode, numericCode: 10019 });
    const side = kind.includes('Buy') ? 'buy' : 'sell';
    const price = this.state.prices.get(symbol);
    const fill = side === 'buy' ? price?.ask ?? 3300 : price?.bid ?? 3300;
    const money = (stop: MtStop, dir: number): number | undefined => {
      if (stop === undefined) return undefined;
      if (typeof stop === 'number') return stop;
      return Math.round((fill + dir * (stop.value / (volume * 100))) * 1000) / 1000;
    };
    const dir = side === 'buy' ? 1 : -1;
    const input = {
      side: side as 'buy' | 'sell',
      volume,
      symbol,
      sl: money(stopLoss, -dir),
      tp: money(takeProfit, dir),
      clientId: options.clientId,
      comment: options.comment,
      magic: options.magic,
    };
    if (this.streamFirst) {
      const p = await this.openAtBroker(input);
      return { numericCode: 10009, stringCode: 'TRADE_RETCODE_DONE', message: 'Request completed', orderId: String(p.id), positionId: String(p.id) };
    }
    const id = this.ticket + 1;
    setTimeout(() => void this.openAtBroker(input), 5);
    return { numericCode: 10009, stringCode: 'TRADE_RETCODE_DONE', message: 'Request completed', orderId: String(id), positionId: String(id) };
  }

  createMarketBuyOrder(symbol: string, volume: number, sl?: MtStop, tp?: MtStop, options?: MtTradeOptions) {
    return this.trade('createMarketBuyOrder', symbol, volume, sl, tp, options);
  }
  createMarketSellOrder(symbol: string, volume: number, sl?: MtStop, tp?: MtStop, options?: MtTradeOptions) {
    return this.trade('createMarketSellOrder', symbol, volume, sl, tp, options);
  }
  private async pending(kind: string, symbol: string, volume: number, openPrice: number, sl: MtStop, tp: MtStop, options: MtTradeOptions = {}): Promise<MtTradeResponse> {
    this.sent.push({ kind, symbol, volume, stopLoss: sl, takeProfit: tp, options, at: performance.now() });
    const order: MtOrder = {
      id: ++this.ticket,
      type: `ORDER_TYPE_${kind.replace('create', '').replace('Order', '').replace(/([a-z])([A-Z])/g, '$1_$2').toUpperCase().split('_').reverse().join('_')}`,
      state: 'ORDER_STATE_PLACED',
      symbol,
      openPrice,
      volume,
      currentVolume: volume,
      time: new Date(),
      clientId: options.clientId,
      stopLoss: typeof sl === 'number' ? sl : undefined,
      takeProfit: typeof tp === 'number' ? tp : undefined,
    };
    this.state.orders.push(order);
    await this.fire('onPendingOrdersUpdated', [order], []);
    await this.fire('onPendingOrderUpdated', order);
    return { numericCode: 10009, stringCode: 'TRADE_RETCODE_DONE', orderId: String(order.id) };
  }
  createLimitBuyOrder(symbol: string, volume: number, price: number, sl?: MtStop, tp?: MtStop, options?: MtTradeOptions) {
    return this.pending('createLimitBuyOrder', symbol, volume, price, sl, tp, options);
  }
  createLimitSellOrder(symbol: string, volume: number, price: number, sl?: MtStop, tp?: MtStop, options?: MtTradeOptions) {
    return this.pending('createLimitSellOrder', symbol, volume, price, sl, tp, options);
  }
  createStopBuyOrder(symbol: string, volume: number, price: number, sl?: MtStop, tp?: MtStop, options?: MtTradeOptions) {
    return this.pending('createStopBuyOrder', symbol, volume, price, sl, tp, options);
  }
  createStopSellOrder(symbol: string, volume: number, price: number, sl?: MtStop, tp?: MtStop, options?: MtTradeOptions) {
    return this.pending('createStopSellOrder', symbol, volume, price, sl, tp, options);
  }
  createStopLimitBuyOrder(symbol: string, volume: number, price: number, _limit: number, sl?: MtStop, tp?: MtStop, options?: MtTradeOptions) {
    return this.pending('createStopLimitBuyOrder', symbol, volume, price, sl, tp, options);
  }
  createStopLimitSellOrder(symbol: string, volume: number, price: number, _limit: number, sl?: MtStop, tp?: MtStop, options?: MtTradeOptions) {
    return this.pending('createStopLimitSellOrder', symbol, volume, price, sl, tp, options);
  }
  async modifyPosition(positionId: string, stopLoss?: MtStop, takeProfit?: MtStop): Promise<MtTradeResponse> {
    this.modifies.push({ positionId, stopLoss, takeProfit });
    await settle(this.latencyMs);
    const p = this.state.positions.find((x) => String(x.id) === positionId);
    if (!p) throw Object.assign(new Error('Position not found'), { stringCode: 'TRADE_RETCODE_POSITION_CLOSED' });
    p.stopLoss = typeof stopLoss === 'number' ? stopLoss : undefined;
    p.takeProfit = typeof takeProfit === 'number' ? takeProfit : undefined;
    await this.fire('onPositionUpdated', p);
    return { numericCode: 10009, stringCode: 'TRADE_RETCODE_DONE', positionId };
  }
  async closePosition(positionId: string): Promise<MtTradeResponse> {
    this.closes.push({ positionId, at: performance.now() });
    await settle(this.latencyMs);
    await this.closeAtBroker(positionId, 'DEAL_REASON_EXPERT');
    return { numericCode: 10009, stringCode: 'TRADE_RETCODE_DONE', positionId };
  }
  async closePositionPartially(positionId: string, volume: number): Promise<MtTradeResponse> {
    this.closes.push({ positionId, volume, at: performance.now() });
    await settle(this.latencyMs);
    await this.closeAtBroker(positionId, 'DEAL_REASON_EXPERT', volume);
    return { numericCode: 10009, stringCode: 'TRADE_RETCODE_DONE', positionId };
  }
  async modifyOrder(orderId: string, openPrice: number): Promise<MtTradeResponse> {
    const o = this.state.orders.find((x) => String(x.id) === orderId);
    if (o) o.openPrice = openPrice;
    return { numericCode: 10009, stringCode: 'TRADE_RETCODE_DONE', orderId };
  }
  async cancelOrder(orderId: string): Promise<MtTradeResponse> {
    this.state.orders = this.state.orders.filter((x) => String(x.id) !== orderId);
    await this.fire('onPendingOrderCompleted', orderId);
    return { numericCode: 10009, stringCode: 'TRADE_RETCODE_DONE', orderId };
  }
}

export class FakeAccount implements MtAccount {
  state = 'DEPLOYED';
  connectionStatus = 'CONNECTED';
  region = 'london';
  type = 'cloud-g2';
  version = 5;
  magic = 0;
  quoteStreamingIntervalInSeconds = 2.5;
  deployed = 0;
  candles: MtCandle[] = [];
  constructor(
    readonly id: string,
    readonly name: string,
    readonly login: string,
    readonly server: string,
    readonly connection: FakeConnection,
  ) {}
  async reload() {}
  async deploy() {
    this.deployed += 1;
    this.state = 'DEPLOYED';
  }
  async redeploy() {}
  async waitDeployed() {}
  async waitConnected() {}
  getStreamingConnection() {
    return this.connection;
  }
  async update(dto: { quoteStreamingIntervalInSeconds?: number }) {
    if (dto.quoteStreamingIntervalInSeconds !== undefined) this.quoteStreamingIntervalInSeconds = dto.quoteStreamingIntervalInSeconds;
  }
  async getHistoricalCandles(_symbol: string, timeframe: string, _start?: Date, limit = 1000): Promise<MtCandle[]> {
    const step = timeframe === '1m' ? 60_000 : 3600_000;
    const end = Math.floor(Date.now() / step) * step;
    // Newest first, as MetaApi returns them.
    return Array.from({ length: Math.min(limit, 50) }, (_, i) => {
      const t = end - i * step;
      return { time: new Date(t), brokerTime: brokerTime(t), open: 3300 + i, high: 3301 + i, low: 3299 + i, close: 3300.5 + i, tickVolume: 100 + i, spread: 20, volume: 0 };
    });
  }
}

export function makeClient(accounts: FakeAccount[]): MetaApiClient & { created: unknown[] } {
  const created: unknown[] = [];
  return {
    created,
    metatraderAccountApi: {
      getAccountsWithInfiniteScrollPagination: async () => accounts,
      getAccount: async (id: string) => {
        const found = accounts.find((a) => a.id === id);
        if (!found) throw new Error('not found');
        return found;
      },
      createAccount: async (dto: never) => {
        created.push(dto);
        const conn = new FakeConnection({ symbol: 'XAUUSD', balance: 500, firstTicket: 9_000_000 });
        const account = new FakeAccount(`ma-${created.length}`, (dto as { name: string }).name, (dto as { login: string }).login, (dto as { server: string }).server, conn);
        accounts.push(account);
        return account;
      },
    },
    close: () => undefined,
  };
}
