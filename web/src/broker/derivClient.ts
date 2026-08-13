import type { Candle, Tick } from '@sentinal/shared';

/**
 * Deriv API client for the browser build.
 *
 * The hosted terminal has no server of its own, so it speaks Deriv's WebSocket
 * protocol directly with the operator's own API token. The token stays in this
 * tab and is sent nowhere except Deriv.
 *
 * Deriv does not expose MetaTrader order entry over its API — an API token
 * trades Deriv's own contracts. Gold is traded there as a *multiplier*
 * contract: you commit a stake, Deriv multiplies your exposure, and the stop
 * loss and take profit are given as money amounts rather than price levels.
 * That maps onto this engine cleanly, because the engine already sizes every
 * leg by money risk. `stakeFor` / `volumeFor` below are the one place the two
 * models are reconciled.
 */

/** Deriv's public app id. Register your own at api.deriv.com to raise limits. */
export const DEFAULT_APP_ID = '1089';

/** The symbol Deriv uses for spot gold. */
export const DEFAULT_SYMBOL = 'frxXAUUSD';

/**
 * Units of gold this terminal treats as one lot. Deriv contracts are staked in
 * currency, not lots, so a convention is needed for the lot-denominated numbers
 * the UI shows; 100 oz is the MetaTrader standard for XAUUSD.
 */
export const CONTRACT_SIZE = 100;

export interface DerivCredentials {
  token: string;
  appId: string;
  symbol: string;
  /** Deriv's exposure multiplier for new contracts. */
  multiplier: number;
}

export interface DerivAccountInfo {
  loginId: string;
  currency: string;
  balance: number;
  isVirtual: boolean;
  landingCompany: string;
  fullName: string;
}

export interface DerivSymbolInfo {
  symbol: string;
  displayName: string;
  pip: number;
  market: string;
  open: boolean;
}

export interface DerivMultiplierTerms {
  multipliers: number[];
  minStake: number;
  maxStake: number;
}

/** A live Deriv contract, normalised from `proposal_open_contract`. */
export interface DerivContract {
  contractId: string;
  contractType: string;
  symbol: string;
  buyPrice: number;
  multiplier: number;
  entrySpot: number;
  currentSpot: number;
  profit: number;
  commission: number;
  purchaseTime: number;
  stopLossAmount: number | null;
  stopLossBarrier: number | null;
  takeProfitAmount: number | null;
  takeProfitBarrier: number | null;
  isSold: boolean;
}

export class BrokerError extends Error {
  readonly code: string;
  constructor(message: string, code = 'error') {
    super(message);
    this.name = 'BrokerError';
    this.code = code;
  }
}

interface Envelope {
  msg_type?: string;
  req_id?: number;
  error?: { code?: string; message?: string };
  [key: string]: unknown;
}

type StreamHandler = (message: Envelope) => void;

/** Rephrases Deriv's error codes into something an operator can act on. */
function describe(code: string, message: string): string {
  switch (code) {
    case 'InvalidToken':
    case 'AuthorizationRequired':
      return 'Deriv rejected the token. Create one at Settings → API token with the Read and Trade scopes.';
    case 'PermissionDenied':
      return 'This token lacks the Trade scope, so it can read the account but not place orders.';
    case 'RateLimit':
      return 'Deriv is rate limiting this token. Wait a moment and reconnect.';
    case 'MarketIsClosed':
      return 'The gold market is closed on Deriv right now.';
    default:
      return message || `Deriv request failed (${code}).`;
  }
}

function num(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Stake that gives the same exposure as `volume` lots.
 *
 * A multiplier contract profits by `stake × multiplier × (Δprice / entry)`,
 * while a lot profits by `Δprice × volume × contractSize`. Equating the two
 * gives the conversion, so every lot figure the UI shows means the same money
 * it would on MetaTrader.
 */
export function stakeFor(volume: number, price: number, multiplier: number): number {
  if (multiplier <= 0 || price <= 0) return 0;
  return Math.round(((volume * CONTRACT_SIZE * price) / multiplier) * 100) / 100;
}

/** The inverse, for reading Deriv's own contracts back as lots. */
export function volumeFor(stake: number, price: number, multiplier: number): number {
  if (price <= 0 || CONTRACT_SIZE <= 0) return 0;
  return Math.round(((stake * multiplier) / (CONTRACT_SIZE * price)) * 10000) / 10000;
}

/** Symbols that are plausibly gold, for when the configured name is unknown. */
export function goldCandidates(symbols: DerivSymbolInfo[]): string[] {
  return symbols
    .filter((entry) => /xau|gold/i.test(entry.symbol) || /gold/i.test(entry.displayName))
    .map((entry) => entry.symbol)
    .slice(0, 12);
}

export class DerivClient {
  private socket: WebSocket | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (v: Envelope) => void; reject: (e: Error) => void }>();
  private readonly streams = new Map<number, StreamHandler>();
  private readonly subscriptionIds = new Set<string>();
  private closedByUs = false;
  private onDrop: ((reason: string) => void) | null = null;

  constructor(private readonly credentials: DerivCredentials) {}

  /* ------------------------------------------------------------------ */
  /* Transport                                                           */
  /* ------------------------------------------------------------------ */

  /** Opens the socket and authorises it. Rejects if either step fails. */
  async open(onDrop?: (reason: string) => void): Promise<DerivAccountInfo> {
    this.onDrop = onDrop ?? null;
    const appId = this.credentials.appId.trim() || DEFAULT_APP_ID;
    const url = `wss://ws.derivws.com/websockets/v3?app_id=${encodeURIComponent(appId)}&l=EN&brand=deriv`;

    await new Promise<void>((resolve, reject) => {
      let socket: WebSocket;
      try {
        socket = new WebSocket(url);
      } catch (err) {
        reject(new BrokerError(`Could not open a socket to Deriv (${err instanceof Error ? err.message : 'error'}).`));
        return;
      }
      this.socket = socket;

      socket.onopen = () => resolve();
      socket.onerror = () =>
        reject(
          new BrokerError(
            'Could not reach Deriv. Check your connection, and check the app id if you registered your own.',
            'NetworkError',
          ),
        );
      socket.onclose = (event) => {
        // A close before open() resolves is a failure; afterwards it is a drop.
        reject(new BrokerError(`Deriv closed the connection (${event.code}).`, 'Disconnected'));
        this.failPending('The Deriv connection dropped.');
        if (!this.closedByUs) this.onDrop?.('The Deriv connection dropped.');
      };
      socket.onmessage = (event) => this.receive(event.data);
    });

    return this.authorize();
  }

  close(): void {
    this.closedByUs = true;
    for (const id of this.subscriptionIds) {
      // Best effort: the socket is about to go anyway.
      this.send({ forget: id }).catch(() => undefined);
    }
    this.subscriptionIds.clear();
    this.streams.clear();
    this.socket?.close();
    this.socket = null;
  }

  private receive(data: unknown): void {
    if (typeof data !== 'string') return;
    let message: Envelope;
    try {
      message = JSON.parse(data) as Envelope;
    } catch {
      return;
    }

    const reqId = typeof message.req_id === 'number' ? message.req_id : undefined;
    if (reqId === undefined) return;

    const subscription = message.subscription as { id?: string } | undefined;
    if (subscription?.id) this.subscriptionIds.add(subscription.id);

    const waiter = this.pending.get(reqId);
    if (waiter) {
      this.pending.delete(reqId);
      if (message.error) {
        waiter.reject(new BrokerError(describe(message.error.code ?? '', message.error.message ?? ''), message.error.code ?? 'error'));
      } else {
        waiter.resolve(message);
      }
      // A subscription's first payload is also its response; later ones are
      // stream-only and fall through to the handler below.
      const handler = this.streams.get(reqId);
      if (handler && !message.error) handler(message);
      return;
    }

    this.streams.get(reqId)?.(message);
  }

  private failPending(reason: string): void {
    for (const [, waiter] of this.pending) waiter.reject(new BrokerError(reason, 'Disconnected'));
    this.pending.clear();
  }

  private send(payload: Record<string, unknown>, stream?: StreamHandler): Promise<Envelope> {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new BrokerError('Not connected to Deriv.', 'Disconnected'));
    }
    const reqId = this.nextId++;
    if (stream) this.streams.set(reqId, stream);

    return new Promise<Envelope>((resolve, reject) => {
      this.pending.set(reqId, { resolve, reject });
      socket.send(JSON.stringify({ ...payload, req_id: reqId }));
      // Deriv answers well inside this; a silent request means something is wrong.
      window.setTimeout(() => {
        if (!this.pending.delete(reqId)) return;
        reject(new BrokerError('Deriv did not answer in time.', 'Timeout'));
      }, 20_000);
    });
  }

  /* ------------------------------------------------------------------ */
  /* Account                                                             */
  /* ------------------------------------------------------------------ */

  private async authorize(): Promise<DerivAccountInfo> {
    const token = this.credentials.token.trim();
    if (!token) throw new BrokerError('An API token is required.', 'InvalidToken');

    const reply = await this.send({ authorize: token });
    const auth = reply.authorize as Record<string, unknown> | undefined;
    if (!auth) throw new BrokerError('Deriv did not return an account for this token.', 'InvalidToken');

    return {
      loginId: String(auth.loginid ?? ''),
      currency: String(auth.currency ?? 'USD'),
      balance: num(auth.balance),
      isVirtual: Boolean(auth.is_virtual),
      landingCompany: String(auth.landing_company_fullname ?? 'Deriv'),
      fullName: String(auth.fullname ?? ''),
    };
  }

  /** Live balance updates, so the displayed equity is Deriv's own figure. */
  async subscribeBalance(handler: (balance: number) => void): Promise<void> {
    await this.send({ balance: 1, subscribe: 1 }, (message) => {
      const balance = message.balance as { balance?: unknown } | undefined;
      if (balance && balance.balance !== undefined) handler(num(balance.balance));
    });
  }

  /* ------------------------------------------------------------------ */
  /* Market data                                                         */
  /* ------------------------------------------------------------------ */

  async activeSymbols(): Promise<DerivSymbolInfo[]> {
    const reply = await this.send({ active_symbols: 'brief', product_type: 'basic' });
    const list = reply.active_symbols;
    if (!Array.isArray(list)) return [];
    return list.map((raw) => {
      const entry = raw as Record<string, unknown>;
      return {
        symbol: String(entry.symbol ?? ''),
        displayName: String(entry.display_name ?? entry.symbol ?? ''),
        pip: num(entry.pip, 0.01),
        market: String(entry.market ?? ''),
        open: Number(entry.exchange_is_open ?? 1) === 1,
      };
    });
  }

  /**
   * The multiplier terms Deriv offers on this symbol for this account.
   *
   * Availability varies by landing company, so this is asked rather than
   * assumed; when the account cannot trade multipliers on gold there is
   * nothing sensible to place and the caller says so.
   */
  async multiplierTerms(symbol = this.credentials.symbol): Promise<DerivMultiplierTerms | null> {
    const reply = await this.send({ contracts_for: symbol, currency: 'USD' });
    const container = reply.contracts_for as { available?: unknown } | undefined;
    const available = container?.available;
    if (!Array.isArray(available)) return null;

    const multipliers = new Set<number>();
    let minStake = Number.POSITIVE_INFINITY;
    let maxStake = 0;

    for (const raw of available) {
      const entry = raw as Record<string, unknown>;
      if (String(entry.contract_category ?? '') !== 'multiplier') continue;
      for (const value of Array.isArray(entry.multiplier_range) ? entry.multiplier_range : []) {
        const parsed = num(value);
        if (parsed > 0) multipliers.add(parsed);
      }
      const min = num(entry.min_contract_amount ?? entry.min_stake, 0);
      const max = num(entry.max_contract_amount ?? entry.max_stake, 0);
      if (min > 0) minStake = Math.min(minStake, min);
      if (max > 0) maxStake = Math.max(maxStake, max);
    }

    if (multipliers.size === 0) return null;
    return {
      multipliers: [...multipliers].sort((a, b) => a - b),
      minStake: Number.isFinite(minStake) ? minStake : 1,
      maxStake: maxStake > 0 ? maxStake : 2000,
    };
  }

  /** Recent one-minute bars, oldest first, for the chart and the indicators. */
  async history(count = 240): Promise<Candle[]> {
    const reply = await this.send({
      ticks_history: this.credentials.symbol,
      style: 'candles',
      granularity: 60,
      count,
      end: 'latest',
    });
    const candles = reply.candles;
    if (!Array.isArray(candles)) return [];

    return candles
      .map((raw) => {
        const bar = raw as Record<string, unknown>;
        return {
          time: num(bar.epoch) * 1000,
          open: num(bar.open),
          high: num(bar.high),
          low: num(bar.low),
          close: num(bar.close),
          volume: 0,
        };
      })
      .filter((bar) => Number.isFinite(bar.time) && bar.close > 0)
      .sort((a, b) => a.time - b.time);
  }

  /**
   * Streams quotes.
   *
   * Deriv publishes one price per tick rather than a bid and an ask — a
   * multiplier contract is charged a commission, not a spread — so both sides
   * of the tick carry that quote instead of an invented spread around it.
   */
  async subscribeTicks(handler: (tick: Tick) => void): Promise<void> {
    await this.send({ ticks: this.credentials.symbol, subscribe: 1 }, (message) => {
      const tick = message.tick as Record<string, unknown> | undefined;
      if (!tick) return;
      const quote = num(tick.quote);
      if (quote <= 0) return;
      handler({
        symbol: this.credentials.symbol,
        bid: quote,
        ask: quote,
        time: num(tick.epoch) * 1000 || Date.now(),
      });
    });
  }

  /* ------------------------------------------------------------------ */
  /* Trading — these open and close real contracts                       */
  /* ------------------------------------------------------------------ */

  /** Streams every open contract on the account, including its running P&L. */
  async subscribeOpenContracts(handler: (contract: DerivContract) => void): Promise<void> {
    await this.send({ proposal_open_contract: 1, subscribe: 1 }, (message) => {
      const raw = message.proposal_open_contract as Record<string, unknown> | undefined;
      if (!raw || !raw.contract_id) return;
      handler(normaliseContract(raw));
    });
  }

  /** Contracts currently open, used to seed the book before the stream warms up. */
  async portfolio(): Promise<string[]> {
    const reply = await this.send({ portfolio: 1 });
    const container = reply.portfolio as { contracts?: unknown } | undefined;
    const contracts = container?.contracts;
    if (!Array.isArray(contracts)) return [];
    return contracts
      .map((raw) => String((raw as Record<string, unknown>).contract_id ?? ''))
      .filter((id) => id.length > 0);
  }

  /**
   * Buys a multiplier contract.
   *
   * `stake` is the money committed and is also the most the contract can lose,
   * so the stop loss is never allowed to exceed it.
   */
  async buy(input: {
    side: 'buy' | 'sell';
    stake: number;
    stopLoss?: number | null;
    takeProfit?: number | null;
  }): Promise<{ contractId: string; buyPrice: number; longcode: string }> {
    const limitOrder: Record<string, number> = {};
    if (input.stopLoss && input.stopLoss > 0) {
      limitOrder.stop_loss = Math.round(Math.min(input.stopLoss, input.stake) * 100) / 100;
    }
    if (input.takeProfit && input.takeProfit > 0) {
      limitOrder.take_profit = Math.round(input.takeProfit * 100) / 100;
    }

    const reply = await this.send({
      buy: '1',
      price: input.stake,
      parameters: {
        amount: input.stake,
        basis: 'stake',
        contract_type: input.side === 'buy' ? 'MULTUP' : 'MULTDOWN',
        currency: 'USD',
        symbol: this.credentials.symbol,
        multiplier: this.credentials.multiplier,
        ...(Object.keys(limitOrder).length > 0 ? { limit_order: limitOrder } : {}),
      },
    });

    const result = reply.buy as Record<string, unknown> | undefined;
    const contractId = result ? String(result.contract_id ?? '') : '';
    if (!contractId) throw new BrokerError('Deriv accepted the request but returned no contract.', 'NoContract');
    return {
      contractId,
      buyPrice: num(result?.buy_price, input.stake),
      longcode: String(result?.longcode ?? ''),
    };
  }

  /** Sells a contract back at market. */
  async sell(contractId: string): Promise<number> {
    const reply = await this.send({ sell: contractId, price: 0 });
    const result = reply.sell as Record<string, unknown> | undefined;
    return num(result?.sold_for);
  }
}

/** Deriv nests limit orders and spots; this flattens one update into our shape. */
function normaliseContract(raw: Record<string, unknown>): DerivContract {
  const limit = raw.limit_order as Record<string, unknown> | undefined;
  const stopLoss = limit?.stop_loss as Record<string, unknown> | undefined;
  const takeProfit = limit?.take_profit as Record<string, unknown> | undefined;

  const barrier = (order: Record<string, unknown> | undefined): number | null => {
    const value = Number(order?.value);
    return Number.isFinite(value) && value > 0 ? value : null;
  };
  const amount = (order: Record<string, unknown> | undefined): number | null => {
    const value = Number(order?.order_amount);
    return Number.isFinite(value) ? Math.abs(value) : null;
  };

  return {
    contractId: String(raw.contract_id ?? ''),
    contractType: String(raw.contract_type ?? ''),
    symbol: String(raw.underlying ?? raw.symbol ?? ''),
    buyPrice: num(raw.buy_price),
    multiplier: num(raw.multiplier, 1),
    entrySpot: num(raw.entry_spot ?? raw.entry_tick),
    currentSpot: num(raw.current_spot ?? raw.entry_spot),
    profit: num(raw.profit),
    // Deriv reports commission as a positive charge already deducted from profit.
    commission: num(raw.commission),
    purchaseTime: num(raw.purchase_time) * 1000 || Date.now(),
    stopLossAmount: amount(stopLoss),
    stopLossBarrier: barrier(stopLoss),
    takeProfitAmount: amount(takeProfit),
    takeProfitBarrier: barrier(takeProfit),
    isSold: Number(raw.is_sold ?? 0) === 1,
  };
}

/* ------------------------------------------------------------------ */
/* Credential storage                                                  */
/* ------------------------------------------------------------------ */

const STORAGE_KEY = 'sentinal.deriv.credentials';

/** Credentials are only persisted when the operator asks for it. */
export function saveCredentials(credentials: DerivCredentials): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(credentials));
  } catch {
    /* private browsing or a full quota — connecting still works for this session */
  }
}

export function loadCredentials(): DerivCredentials | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<DerivCredentials>;
    if (!parsed.token) return null;
    return {
      token: parsed.token,
      appId: parsed.appId ?? DEFAULT_APP_ID,
      symbol: parsed.symbol ?? DEFAULT_SYMBOL,
      multiplier: Number(parsed.multiplier) > 0 ? Number(parsed.multiplier) : 100,
    };
  } catch {
    return null;
  }
}

export function clearCredentials(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* nothing to clear */
  }
}
