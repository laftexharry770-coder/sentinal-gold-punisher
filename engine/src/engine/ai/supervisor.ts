import type { AiReview, AiStatus, Side } from '@sentinal/shared';
import { Emitter } from '../../emitter.js';
import type { AccountManager } from '../../broker/manager.js';
import type { Journal } from '../../journal.js';
import { uid } from '../../util.js';
import type { BotEngine } from '../bot.js';
import type { BrainState } from './brain.js';
import { boundSuggestion, type AiReviewClient, type ReviewInput, type ReviewSuggestion, type ReviewTrade } from './review.js';

/** Where the AI's model is kept between sessions. */
export interface AiStore {
  load(): unknown;
  save(state: BrainState): void;
}

export interface SupervisorOptions {
  store?: AiStore;
  /** Returns the reviewer when an API key is available, null otherwise. */
  reviewer?: () => AiReviewClient | null;
  /** Wall clock, for tests. */
  now?: () => number;
}

const STATUS_EVERY_MS = 1_000;
const SAVE_EVERY_MS = 5 * 60_000;
const MAX_REVIEWS = 20;

/**
 * Looks after the AI as a whole: sends its reading to the terminal about
 * once a second, keeps its model saved, and runs Claude's reviews — on a
 * timer while the AI is trading, after a number of AI trades, or on request.
 * A review's suggestion is held inside the operator's limits and applied at
 * once, or kept for approval when auto-apply is off.
 */
export class AiSupervisor extends Emitter {
  private readonly reviews: AiReview[] = [];
  private pending: { review: AiReview; suggestion: ReviewSuggestion } | null = null;
  private readonly trades: ReviewTrade[] = [];
  private busy = false;
  private lastReviewAt: number | null = null;
  private tradesSinceReview = 0;
  private lastStatusAt = 0;
  private lastSaveAt: number;
  private reviewer: (() => AiReviewClient | null) | null;
  private readonly store: AiStore | null;
  private readonly now: () => number;

  constructor(
    private readonly bot: BotEngine,
    private readonly accounts: AccountManager,
    private readonly journal: Journal,
    options: SupervisorOptions = {},
  ) {
    super();
    this.store = options.store ?? null;
    this.reviewer = options.reviewer ?? null;
    this.now = options.now ?? (() => Date.now());
    this.lastSaveAt = this.now();
    if (this.store) {
      try {
        if (this.bot.brain.importState(this.store.load())) {
          this.journal.write('info', null, 'AI model restored — it carries on learning from where it left off');
        }
      } catch {
        /* a damaged save is ignored: the AI starts fresh */
      }
    }
    this.bot.on('ai-trade', (t: { side: Side; regime: ReviewTrade['regime']; r: number; netProfit: number; probability: number | null }) => {
      this.trades.push({ time: this.now(), side: t.side, regime: t.regime, probability: t.probability, r: t.r, netProfit: t.netProfit });
      if (this.trades.length > 40) this.trades.shift();
      this.tradesSinceReview += 1;
      const claude = this.bot.config.ai.claude;
      if (claude.enabled && claude.afterTrades > 0 && this.tradesSinceReview >= claude.afterTrades) void this.review('trades');
    });
  }

  /** Swaps the reviewer, e.g. when an API key is entered or removed. */
  setReviewer(reviewer: (() => AiReviewClient | null) | null): void {
    this.reviewer = reviewer;
    this.publish();
  }

  private client(): AiReviewClient | null {
    try {
      return this.reviewer?.() ?? null;
    } catch {
      return null;
    }
  }

  /** True while the AI is making decisions: trading itself, or directing Burst. */
  private aiInCharge(): boolean {
    const c = this.bot.config;
    return this.bot.stats().running && (c.strategy === 'ai' || (c.strategy === 'burst' && c.burst.direction === 'ai'));
  }

  private nextReviewAt(): number | null {
    const claude = this.bot.config.ai.claude;
    if (!claude.enabled || claude.intervalMin <= 0 || !this.aiInCharge()) return null;
    return (this.lastReviewAt ?? this.bot.stats().startedAt ?? this.now()) + claude.intervalMin * 60_000;
  }

  status(): AiStatus {
    const now = this.now();
    return {
      reading: this.bot.brain.read(this.bot.config.ai.minProbability),
      reviews: [...this.reviews],
      claude: {
        configured: this.client() !== null,
        busy: this.busy,
        lastReviewAt: this.lastReviewAt,
        nextReviewAt: this.nextReviewAt(),
      },
      pausedUntil: this.bot.aiPausedUntil > now ? this.bot.aiPausedUntil : null,
      pending: this.pending?.review ?? null,
      guard: { ...this.bot.guard },
    };
  }

  publish(): void {
    this.lastStatusAt = this.now();
    this.emit('ai', this.status());
  }

  /** Called on every quote: status out about once a second, a save every few minutes, reviews when due. */
  onTick(): void {
    const now = this.now();
    if (now - this.lastStatusAt >= STATUS_EVERY_MS) this.publish();
    if (now - this.lastSaveAt >= SAVE_EVERY_MS) this.save();
    const due = this.nextReviewAt();
    if (due !== null && now >= due && !this.busy) void this.review('schedule');
  }

  save(): void {
    this.lastSaveAt = this.now();
    if (!this.store) return;
    try {
      this.store.save(this.bot.brain.exportState(this.lastSaveAt));
    } catch {
      /* storage full or unavailable: the model lives on in memory */
    }
  }

  private input(): ReviewInput {
    const cfg = this.bot.config;
    const reading = this.bot.brain.read(cfg.ai.minProbability);
    const master = this.accounts.primary();
    const stats = this.bot.stats();
    const round = (v: number) => Math.round(v * 100) / 100;
    return {
      time: new Date(this.now()).toISOString(),
      symbol: cfg.symbol,
      balance: round(master?.balance ?? 0),
      equity: round(master?.equity() ?? 0),
      settings: {
        minProbability: cfg.ai.minProbability,
        riskPercent: cfg.ai.riskPercent,
        maxRiskPercent: cfg.ai.maxRiskPercent,
        slAtr: cfg.ai.slAtr,
        rrMin: cfg.ai.rrMin,
        rrMax: cfg.ai.rrMax,
        maxPositions: cfg.ai.maxPositions,
        tradeVolatile: cfg.ai.tradeVolatile,
      },
      reading: {
        regime: reading.regime,
        probabilityUp: reading.probabilityUp,
        threshold: reading.threshold,
        atr: reading.atr,
        adx: reading.adx,
        efficiency: reading.efficiency,
        volatilityRatio: reading.volatilityRatio,
        spreadRatio: reading.spreadRatio,
        danger: reading.danger,
        reasons: reading.reasons,
      },
      learning: reading.learning,
      experts: reading.experts.map((e) => ({ name: e.name, score: e.score, weight: e.weight, hitRate: e.hitRate })),
      weights: this.bot.brain.weightTable(),
      regimeResults: this.bot.brain.regimeResults(),
      recentTrades: [...this.trades].slice(-20),
      recentBars: this.bot.brain.recentBars(60).map((b) => ({
        time: new Date(b.time).toISOString(),
        open: round(b.open),
        high: round(b.high),
        low: round(b.low),
        close: round(b.close),
      })),
      day: { profit: stats.dailyProfit, trades: stats.dailyTrades },
    };
  }

  /**
   * Asks Claude to review the AI. Returns the review, or null when none ran
   * (no key, one already running). A failed call is recorded and shown, and
   * the AI carries on unchanged.
   */
  async review(trigger: 'schedule' | 'trades' | 'request'): Promise<AiReview | null> {
    if (this.busy) return null;
    const client = this.client();
    if (!client) {
      if (trigger === 'request') this.journal.write('warn', null, 'Claude review needs an Anthropic API key — add one in Settings → AI');
      return null;
    }
    const model = this.bot.config.ai.claude.model;
    this.busy = true;
    this.lastReviewAt = this.now();
    this.tradesSinceReview = 0;
    this.publish();
    let review: AiReview;
    try {
      const result = await client.review(this.input(), model);
      const changes = boundSuggestion(result.suggestion, this.bot.config.ai);
      const auto = this.bot.config.ai.claude.autoApply;
      review = {
        id: uid('rev'),
        time: this.now(),
        model: result.model,
        assessment: String(result.suggestion.assessment ?? '').slice(0, 1200),
        changes: changes.describe,
        applied: false,
        error: null,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
      };
      if (changes.describe.length === 0) {
        this.journal.write('info', null, `Claude reviewed the AI — no changes. ${review.assessment}`);
      } else if (auto) {
        this.apply(changes);
        review.applied = true;
        this.journal.write('success', null, `Claude reviewed the AI and changed: ${changes.describe.join('; ')}`);
      } else {
        this.pending = { review, suggestion: result.suggestion };
        this.journal.write('info', null, `Claude suggests: ${changes.describe.join('; ')} — approve it in Settings → AI`);
      }
    } catch (err) {
      review = {
        id: uid('rev'),
        time: this.now(),
        model,
        assessment: '',
        changes: [],
        applied: false,
        error: err instanceof Error ? err.message : String(err),
        inputTokens: null,
        outputTokens: null,
      };
      this.journal.write('error', null, `Claude review failed: ${review.error}`);
    } finally {
      this.busy = false;
    }
    this.reviews.unshift(review);
    if (this.reviews.length > MAX_REVIEWS) this.reviews.pop();
    this.publish();
    return review;
  }

  private apply(changes: ReturnType<typeof boundSuggestion>): void {
    if (Object.keys(changes.config).length > 0) this.bot.updateConfig({ ai: { ...this.bot.config.ai, ...changes.config } });
    if (Object.keys(changes.expertBias).length > 0) this.bot.brain.nudge(changes.expertBias);
    if (changes.pauseMinutes > 0) this.bot.aiPausedUntil = this.now() + changes.pauseMinutes * 60_000;
  }

  /** Applies the suggestion waiting for approval. */
  approvePending(): AiReview | null {
    const pending = this.pending;
    if (!pending) return null;
    this.pending = null;
    // The operator may have changed settings since: bound it again against today's.
    const changes = boundSuggestion(pending.suggestion, this.bot.config.ai);
    const review = this.reviews.find((r) => r.id === pending.review.id);
    this.apply(changes);
    if (review) {
      review.applied = true;
      review.changes = changes.describe;
    }
    this.journal.write('success', null, `Applied Claude's suggestion: ${changes.describe.join('; ') || 'nothing left to change'}`);
    this.publish();
    return review ?? pending.review;
  }

  dismissPending(): void {
    if (!this.pending) return;
    this.pending = null;
    this.journal.write('info', null, "Dismissed Claude's suggestion");
    this.publish();
  }

  /** Lifts a pause Claude set. */
  resume(): void {
    this.bot.aiPausedUntil = 0;
    this.publish();
  }
}
