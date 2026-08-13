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

/**
 * Deriv answers on several WebSocket hostnames that front the same API.
 * They are tried in order, so one blocked or unhealthy endpoint does not
 * present itself as Deriv being down.
 */
export const DERIV_HOSTS = ['ws.derivws.com', 'ws.binaryws.com', 'blue.derivws.com', 'green.derivws.com'];

/** Where a token is exchanged for an authenticated socket. */
export const DERIV_REST_BASE = 'https://api.derivws.com';

/**
 * An app id travels in the connection URL, so a malformed one makes Deriv
 * refuse the handshake — which reads exactly like a blocked network.
 *
 * Only characters that cannot survive a URL are rejected. Deriv's shared ids
 * are integers and its developer portal issues alphanumeric ones, so the shape
 * is Deriv's business: a rule invented here would reject real app ids, and has.
 */
export function isValidAppId(appId: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(appId.trim());
}

/**
 * Whether an account id names a demo account.
 *
 * Deriv's trading accounts are prefixed by kind: DOT for demo and ROT for
 * real on the options-trading API, VRTC and CR on the older accounts. Only
 * the leading letter is read, so an unfamiliar prefix still lands somewhere
 * sensible, and anything unrecognised is treated as real — the cautious way
 * round for a label that sits next to a live-trading switch.
 */
export function isDemoAccountId(accountId: string): boolean {
  const id = accountId.trim().toUpperCase();
  return id.startsWith('D') || id.startsWith('VR');
}

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
  /**
   * The Deriv account the session runs on, e.g. DOT93898941 or ROT92291419.
   * Set, it selects Deriv's current scheme, where the token is exchanged over
   * REST for a socket that is already signed in. Empty, the older flow signs
   * in over the socket instead.
   */
  accountId: string;
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

/**
 * A MetaTrader 5 account Deriv holds for this user.
 *
 * Deriv's API reports these but will not take orders for them — placing a
 * trade on MT5 needs something that speaks the MetaTrader protocol. They are
 * shown so the terminal can account for money it can see, and are marked
 * plainly as not tradable from here.
 */
export interface DerivMt5Account {
  login: string;
  server: string;
  balance: number;
  currency: string;
  /** Deriv's own words: 'demo' or 'real'. */
  accountType: string;
  marketType: string;
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

/**
 * Turns a Deriv error into something an operator can act on.
 *
 * Deriv's own message is always kept: it distinguishes a token that is
 * malformed from one that is valid but for another app or account, and no
 * guess made here can tell those apart. Advice is added after it, never
 * instead of it.
 */
function describe(code: string, message: string): string {
  const said = message ? `Deriv said: “${message}”` : `Deriv returned ${code || 'an error'}.`;

  switch (code) {
    case 'InvalidToken':
    case 'AuthorizationRequired':
      return (
        `${said} Check the whole token was copied — a truncated paste looks exactly like a wrong one — and ` +
        'that it was created on the Deriv account you mean to trade, under Settings → API token, with the ' +
        'Read scope (plus Trade to place orders).'
      );
    case 'PermissionDenied':
      return `${said} The token is valid but lacks the scope for that call — Trade is the one needed to place orders.`;
    case 'RateLimit':
      return `${said} Wait a moment and reconnect; registering your own app id at api.deriv.com raises the limit.`;
    case 'MarketIsClosed':
      return `${said} Gold is closed on Deriv right now.`;
    case 'UnrecognisedRequest':
      // The trading socket carries the calls trading needs and no more, so an
      // unknown method is a missing feature rather than a malformed request.
      return `${said} This Deriv session does not offer that call.`;
    default:
      return message ? `${said} (${code})` : `Deriv request failed (${code}).`;
  }
}

/**
 * Flags a token that cannot be right before Deriv is asked.
 *
 * Only faults evident from the text itself: a space, a line break, or
 * punctuation means something other than the token was copied. Length is
 * deliberately not judged — Deriv issues tokens of more than one size, and a
 * length rule guessed here would reject a working one. The field prints its
 * own character count instead, which is a fact rather than an opinion, and
 * Deriv keeps the final say.
 */
export function tokenShapeWarning(token: string): string | null {
  const trimmed = token.trim();
  if (trimmed.length === 0) return null;
  if (/\s/.test(trimmed)) return 'This token has a space or line break inside it — copy it again.';
  if (!/^[A-Za-z0-9_-]+$/.test(trimmed)) {
    return 'This token has punctuation in it, so something other than the token was copied.';
  }
  return null;
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
  private appIdUsed = DEFAULT_APP_ID;
  private fellBackFrom: string | null = null;

  constructor(private readonly credentials: DerivCredentials) {}

  /* ------------------------------------------------------------------ */
  /* Transport                                                           */
  /* ------------------------------------------------------------------ */

  /**
   * Dials one Deriv endpoint.
   *
   * Resolves with an open socket, or rejects saying which way it failed —
   * a handshake that never completes and a connection Deriv accepts and then
   * drops have different causes, and the operator needs to be told which
   * happened rather than "could not connect".
   */
  private dial(host: string, appId: string): Promise<WebSocket> {
    return this.dialUrl(
      `wss://${host}/websockets/v3?app_id=${encodeURIComponent(appId)}&l=EN&brand=deriv`,
      host,
    );
  }

  /** Dials a URL Deriv has given us, reporting failures the same way. */
  private dialUrl(url: string, host: string): Promise<WebSocket> {
    return new Promise<WebSocket>((resolve, reject) => {
      let socket: WebSocket;
      try {
        socket = new WebSocket(url);
      } catch (err) {
        reject(new BrokerError(`${host} could not be dialled (${err instanceof Error ? err.message : 'error'}).`, 'NetworkError'));
        return;
      }

      let settled = false;
      const finish = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        socket.onopen = null;
        socket.onerror = null;
        socket.onclose = null;
        fn();
      };

      const timer = window.setTimeout(
        () =>
          finish(() => {
            socket.close();
            reject(new BrokerError(`${host} did not answer.`, 'Timeout'));
          }),
        10_000,
      );

      socket.onopen = () => finish(() => resolve(socket));
      socket.onerror = () =>
        finish(() => reject(new BrokerError(`${host} refused the connection.`, 'NetworkError')));
      socket.onclose = (event) =>
        finish(() =>
          reject(new BrokerError(`${host} closed the connection before it opened (${event.code}).`, 'Rejected')),
        );
    });
  }

  /**
   * Exchanges the access token for a WebSocket URL Deriv has already
   * authenticated.
   *
   * This is Deriv's current scheme: the token is presented as a bearer
   * credential over REST and the app id travels as a header, rather than the
   * token being sent in an `authorize` message and the app id in the query
   * string. A socket opened from the returned URL arrives already signed in.
   */
  private async authenticatedUrl(accountId: string, appId: string, token: string): Promise<string> {
    const endpoint = `${DERIV_REST_BASE}/trading/v1/options/accounts/${encodeURIComponent(accountId)}/otp`;

    let response: Response;
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Deriv-App-ID': appId },
      });
    } catch (err) {
      throw new BrokerError(
        `Could not reach Deriv to open a session (${err instanceof Error ? err.message : 'network error'}). ` +
          'Some mobile networks, ISPs and countries block Deriv; check whether deriv.com loads here.',
        'NetworkError',
      );
    }

    if (response.status === 401 || response.status === 403) {
      throw new BrokerError(
        `Deriv rejected the credentials (${response.status}). The token must be a personal access token from ` +
          `developers.deriv.com, and app id ${appId} must be the one it was issued under.`,
        'InvalidToken',
      );
    }
    if (response.status === 404) {
      throw new BrokerError(
        `Deriv does not recognise account ${accountId}. Use the id shown against the account itself — ` +
          'a demo one begins DOT, a real one ROT.',
        'UnknownAccount',
      );
    }
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new BrokerError(
        `Deriv refused to open a session (${response.status})${body ? `: ${body.trim().slice(0, 200)}` : '.'}`,
        'SessionRefused',
      );
    }

    const body = (await response.json().catch(() => null)) as { data?: { url?: string } } | null;
    const url = body?.data?.url;
    if (!url) throw new BrokerError('Deriv opened a session but returned no socket address for it.', 'SessionRefused');
    return url;
  }

  /**
   * Opens a session on an account id, over a socket Deriv has pre-authorised.
   *
   * No `authorize` is sent: the URL already carries the identity, so the
   * account is read from the balance instead.
   */
  private async openAuthenticated(accountId: string, appId: string): Promise<DerivAccountInfo> {
    const url = await this.authenticatedUrl(accountId, appId, this.credentials.token.trim());
    const host = (() => {
      try {
        return new URL(url).host;
      } catch {
        return 'the address Deriv returned';
      }
    })();

    const socket = await this.dialUrl(url, host);
    this.socket = socket;
    this.appIdUsed = appId;
    socket.onmessage = (event) => this.receive(event.data);
    socket.onclose = () => {
      this.failPending('The Deriv connection dropped.');
      if (!this.closedByUs) this.onDrop?.('The Deriv connection dropped.');
    };

    const reply = await this.send({ balance: 1 });
    const balance = (reply.balance ?? {}) as Record<string, unknown>;
    const loginId = String(balance.loginid ?? accountId);

    return {
      loginId,
      currency: String(balance.currency ?? 'USD'),
      balance: num(balance.balance),
      // The pre-authorised socket does not restate which kind of account this
      // is, so the id says: DOT/VRTC are demo, ROT/CR are real.
      isVirtual: isDemoAccountId(loginId),
      landingCompany: 'Deriv',
      fullName: '',
    };
  }

  /** Opens the socket and authorises it. Rejects if either step fails. */
  async open(onDrop?: (reason: string) => void): Promise<DerivAccountInfo> {
    this.onDrop = onDrop ?? null;
    const appId = this.credentials.appId.trim() || DEFAULT_APP_ID;
    const accountId = this.credentials.accountId.trim();

    // An account id means Deriv's current scheme, where the token is exchanged
    // for an authenticated socket. Without one, fall back to the older flow
    // that signs in over the socket itself.
    if (accountId) return this.openAuthenticated(accountId, appId);

    // Checked before dialling: characters that cannot survive a URL fail the
    // handshake on every host, which is indistinguishable from a blocked
    // network once the attempts have already been made.
    if (!isValidAppId(appId)) {
      throw new BrokerError(
        `"${appId}" cannot be an app id — it has a space or punctuation in it. Copy it from your app on ` +
          "developers.deriv.com, or clear the field to use Deriv's shared id.",
        'InvalidAppId',
      );
    }

    // Deriv answers on several hostnames, and not every app id is accepted on
    // every one. Falling back to the shared id means a registration the API
    // will not take is a note in the log rather than a locked door.
    const attempts: string[] = [];
    const candidates = appId === DEFAULT_APP_ID ? [appId] : [appId, DEFAULT_APP_ID];

    for (const candidate of candidates) {
      let socket: WebSocket | null = null;
      for (const host of DERIV_HOSTS) {
        try {
          socket = await this.dial(host, candidate);
          break;
        } catch (err) {
          attempts.push(`[${candidate}] ${err instanceof Error ? err.message : `${host} failed.`}`);
        }
      }
      if (!socket) continue;

      this.socket = socket;
      this.appIdUsed = candidate;
      // Recorded before authorising, so a rejected token can say which app id
      // carried it — the message is composed inside that call.
      this.fellBackFrom = candidate === appId ? null : appId;
      socket.onmessage = (event) => this.receive(event.data);
      // Until the account is authorised a close is this candidate failing, not
      // a session dropping, so nothing is torn down on its behalf yet.
      socket.onclose = () => this.failPending('Deriv closed the connection without answering.');

      try {
        const info = await this.authorize();
        // Only now is the session real enough for a close to mean a drop.
        socket.onclose = () => {
          this.failPending('The Deriv connection dropped.');
          if (!this.closedByUs) this.onDrop?.('The Deriv connection dropped.');
        };
        return info;
      } catch (err) {
        // Deriv hanging up mid-authorise is how it refuses an app id it will
        // not serve: the handshake succeeds, then the socket closes unanswered.
        if (err instanceof BrokerError && err.code === 'Disconnected') {
          attempts.push(`[${candidate}] Deriv closed the connection without answering — the app id was refused.`);
          socket.onclose = null;
          socket.close();
          this.socket = null;
          this.fellBackFrom = null;
          continue;
        }
        throw err;
      }
    }

    const tried = candidates.length > 1 ? `app ids ${candidates.join(' and ')}` : `app id ${appId}`;
    const refused = attempts.some((line) => line.includes('refused') || line.includes('before it opened'));
    throw new BrokerError(
      refused
        ? `Deriv would not serve ${tried}. Check the app id against your app on developers.deriv.com. ` +
          `(${attempts.join(' ')})`
        : `No Deriv endpoint could be reached from this browser, with ${tried}. Your token was never sent, so ` +
          `this is the network rather than your credentials: some mobile networks, ISPs and countries block ` +
          `Deriv. Try a different network, and check whether deriv.com itself loads here. (${attempts.join(' ')})`,
      'NetworkError',
    );
  }

  /** The app id the open socket is actually using, after any fallback. */
  get activeAppId(): string {
    return this.appIdUsed;
  }

  /** Set when the configured app id was refused and the shared one took over. */
  get refusedAppId(): string | null {
    return this.fellBackFrom;
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

    let reply: Envelope;
    try {
      reply = await this.send({ authorize: token });
    } catch (err) {
      // Deriv cannot say whether a rejected token was mistyped or truncated,
      // but the length can, and it gives that away without printing a secret.
      if (err instanceof BrokerError && (err.code === 'InvalidToken' || err.code === 'AuthorizationRequired')) {
        // A token issued for one app is not valid under another, so which app
        // id carried it matters as much as the token itself.
        const note = this.fellBackFrom
          ? `Deriv refused app id ${this.fellBackFrom}, so ${this.appIdUsed} carried the request — and a token ` +
            'issued alongside your own app does not authorise under a different one. A token made under ' +
            'Deriv → Settings → API token belongs to the account rather than to an app, and does.'
          : `Sent with app id ${this.appIdUsed}.`;
        throw new BrokerError(`${err.message} (${token.length} characters were sent. ${note})`, err.code);
      }
      throw err;
    }

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

  /**
   * The MetaTrader 5 accounts Deriv holds for this user.
   *
   * Read-only by necessity: Deriv's API manages MT5 accounts but has no call
   * that places an order on one, so these are reported and never traded. An
   * account that cannot answer this returns nothing rather than failing the
   * session, since the terminal works without it.
   */
  async mt5Accounts(): Promise<DerivMt5Account[]> {
    const reply = await this.send({ mt5_login_list: 1 }).catch(() => null);
    const list = reply?.mt5_login_list;
    if (!Array.isArray(list)) return [];

    return list
      .map((raw) => {
        const entry = raw as Record<string, unknown>;
        const server = entry.server_info as { id?: unknown } | undefined;
        return {
          // Deriv prefixes the login (MTD41204838); the bare digits are what
          // MetaTrader itself shows, so both halves are kept legible.
          login: String(entry.login ?? '').replace(/^MT[DR]?/i, ''),
          server: String(server?.id ?? entry.server ?? ''),
          balance: num(entry.balance),
          currency: String(entry.currency ?? 'USD'),
          accountType: String(entry.account_type ?? ''),
          marketType: String(entry.market_type ?? ''),
        };
      })
      .filter((account) => account.login.length > 0);
  }

  /**
   * Checks an MT5 login and password with Deriv.
   *
   * This is as far as "signing in to MT5" can go here: Deriv will confirm the
   * password belongs to the login, which proves the account is the operator's,
   * but it exposes no call that places an order on it. The password is sent to
   * Deriv and kept nowhere.
   */
  async checkMt5Password(login: string, password: string, kind: 'main' | 'investor'): Promise<void> {
    await this.send({
      mt5_password_check: 1,
      login,
      password,
      password_type: kind,
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
      accountId: parsed.accountId ?? '',
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
