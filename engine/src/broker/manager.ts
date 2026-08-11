import { Emitter } from '../emitter.js';
import {
  DEFAULT_COPY_SETTINGS,
  type AccountConfig,
  type AccountState,
  type ClosedTrade,
  type PortfolioSnapshot,
  type Position,
  type Tick,
} from '@sentinal/shared';
import { round, uid } from '../util.js';
import { TradingAccount } from './account.js';

/**
 * Builds an account for a provider the core does not implement itself.
 * The server registers the MetaApi adapter this way, which keeps the engine
 * free of transport code and lets it run unchanged in a browser.
 */
export type AccountFactory = (config: AccountConfig) => TradingAccount;

export interface NewAccountInput {
  name: string;
  provider?: AccountConfig['provider'];
  login: string;
  password?: string;
  server: string;
  broker?: string;
  currency?: string;
  leverage?: number;
  role?: AccountConfig['role'];
  initialBalance?: number;
  metaApiAccountId?: string;
  copy?: Partial<AccountConfig['copy']>;
}

/** Owns every linked account and fans the market feed out to all of them. */
export class AccountManager extends Emitter {
  private accounts = new Map<string, TradingAccount>();
  private factories = new Map<AccountConfig['provider'], AccountFactory>();
  private lastTick: Tick | null = null;

  /** Teaches the manager how to build accounts for a remote provider. */
  registerProvider(provider: AccountConfig['provider'], factory: AccountFactory): void {
    this.factories.set(provider, factory);
  }

  list(): TradingAccount[] {
    return [...this.accounts.values()];
  }

  get(id: string): TradingAccount | undefined {
    return this.accounts.get(id);
  }

  states(): AccountState[] {
    return this.list().map((a) => a.state());
  }

  /** The account the bot trades. Masters win, otherwise the first account. */
  primary(): TradingAccount | undefined {
    return this.list().find((a) => a.config.role === 'master') ?? this.list()[0];
  }

  slavesOf(masterId: string): TradingAccount[] {
    return this.list().filter(
      (a) => a.config.role === 'slave' && a.config.copy.enabled && a.config.copy.masterId === masterId,
    );
  }

  add(input: NewAccountInput): TradingAccount {
    const config: AccountConfig = {
      id: uid('acc'),
      name: input.name,
      provider: input.provider ?? 'sim',
      login: input.login,
      server: input.server,
      broker: input.broker ?? 'Sentinal Markets',
      currency: input.currency ?? 'USD',
      leverage: input.leverage ?? 500,
      role: input.role ?? 'standalone',
      initialBalance: input.initialBalance ?? 10_000,
      metaApiAccountId: input.metaApiAccountId,
      copy: { ...DEFAULT_COPY_SETTINGS, ...input.copy },
    };

    // A follower linked without an explicit master attaches to the running one.
    if (config.role === 'slave' && config.copy.enabled && !config.copy.masterId) {
      const master = this.list().find((a) => a.config.role === 'master');
      if (master) config.copy = { ...config.copy, masterId: master.id };
    }

    const factory = this.factories.get(config.provider);
    const account = factory ? factory(config) : new TradingAccount(config);

    this.wire(account);
    this.accounts.set(account.id, account);
    // Prime the book with the current quote so the account can trade — and
    // accept mirrored legs — without waiting for the next tick.
    if (this.lastTick) account.onTick(this.lastTick);

    // Local accounts resolve immediately; remote ones dial their broker.
    void account.connect().catch(() => {
      /* connectionError is surfaced through account state */
    });

    this.emit('accounts', this.states());
    return account;
  }

  update(id: string, patch: Partial<AccountConfig>): TradingAccount | undefined {
    const account = this.accounts.get(id);
    if (!account) return undefined;
    account.config = {
      ...account.config,
      ...patch,
      copy: { ...account.config.copy, ...(patch.copy ?? {}) },
      id: account.id,
    };
    this.emit('accounts', this.states());
    return account;
  }

  remove(id: string): boolean {
    const account = this.accounts.get(id);
    if (!account) return false;
    account.closeAll('manual');
    account.disconnect();
    account.removeAllListeners();
    this.accounts.delete(id);
    // Orphaned followers fall back to standalone rather than silently idling.
    for (const other of this.list()) {
      if (other.config.copy.masterId === id) {
        other.config.copy = { ...other.config.copy, enabled: false, masterId: null };
        if (other.config.role === 'slave') other.config.role = 'standalone';
      }
    }
    this.emit('accounts', this.states());
    return true;
  }

  private wire(account: TradingAccount): void {
    account.on('opened', (position: Position) => this.emit('opened', position, account));
    account.on('closed', (trade: ClosedTrade, position: Position) =>
      this.emit('closed', trade, position, account),
    );
    account.on('changed', () => this.emit('changed', account));
  }

  onTick(tick: Tick): void {
    this.lastTick = tick;
    for (const account of this.accounts.values()) account.onTick(tick);
  }

  allPositions(): Position[] {
    return this.list().flatMap((a) => a.listPositions());
  }

  allHistory(limit = 200): ClosedTrade[] {
    return this.list()
      .flatMap((a) => a.history)
      .sort((a, b) => b.closeTime - a.closeTime)
      .slice(0, limit);
  }

  portfolio(): PortfolioSnapshot {
    let balance = 0;
    let equity = 0;
    let margin = 0;
    let floating = 0;
    let realised = 0;
    let openPositions = 0;

    for (const account of this.accounts.values()) {
      const state = account.state();
      balance += state.balance;
      equity += state.equity;
      margin += state.margin;
      floating += account.floatingProfit();
      realised += state.balance - account.config.initialBalance;
      openPositions += state.openPositions;
    }

    return {
      balance: round(balance),
      equity: round(equity),
      margin: round(margin),
      freeMargin: round(equity - margin),
      floatingProfit: round(floating),
      realisedProfit: round(realised),
      openPositions,
      accounts: this.accounts.size,
    };
  }
}
