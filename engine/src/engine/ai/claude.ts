import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import * as z from 'zod/v4';
import { AI_EXPERTS, type AiExpertName } from '@sentinal/shared';
import type { AiReviewClient, ReviewInput, ReviewResult, ReviewSuggestion } from './review.js';

/** The model used unless the operator picks another in Settings. */
export const DEFAULT_REVIEW_MODEL = 'claude-opus-5';

/** Models offered for reviews: both take adaptive thinking and structured output. */
export const REVIEW_MODELS = [
  { id: 'claude-opus-5', label: 'Claude Opus 5', note: 'most capable (default)' },
  { id: 'claude-sonnet-5', label: 'Claude Sonnet 5', note: 'faster, lower cost' },
] as const;

const EXPERT_NAMES = AI_EXPERTS.map((e) => e.name) as [AiExpertName, ...AiExpertName[]];

/**
 * What Claude answers with. Every field is present; null means "leave this
 * setting as it is". Bounds are not asked of the model: the terminal holds
 * every value inside the operator's limits itself.
 */
const ReviewSchema = z.object({
  assessment: z.string(),
  minProbability: z.number().nullable(),
  riskPercent: z.number().nullable(),
  slAtr: z.number().nullable(),
  rrMin: z.number().nullable(),
  rrMax: z.number().nullable(),
  maxPositions: z.number().nullable(),
  tradeVolatile: z.boolean().nullable(),
  expertBias: z.array(z.object({ expert: z.enum(EXPERT_NAMES), multiplier: z.number() })),
  pauseMinutes: z.number().nullable(),
});

const SYSTEM = `You review an automated XAUUSD (gold) trading model for the person who runs it, and adjust its settings.

The model reads one-minute bars and every quote. It classifies the market into a regime (trend-up, trend-down, range, volatile, quiet), scores it with eight experts (trend, momentum, breakout, reversion, squeeze, flow, candles, session) whose weights per regime it learns from how often each was right, and calibrates their vote into a probability that price is higher after a few bars. It trades only when that probability clears its threshold, with a stop sized from ATR and a target sized from its confidence, and it raises its own threshold after losses and in regimes that keep losing.

You receive its current settings, its latest reading, how accurate its predictions have been, its experts' weights and hit rates, its results per regime, its last trades and the last hour of bars. Judge whether its settings suit what the evidence shows, then suggest changes:
- minProbability: the probability it needs before trading (0.52-0.90). Raise it when its confident predictions are not beating a coin toss or it is losing; lower it only with clear evidence of an edge.
- riskPercent: equity risked per trade. You may lower it freely; the terminal allows at most doubling it and never above the operator's cap.
- slAtr, rrMin, rrMax: stop in ATR, and the reward-to-risk range of its targets.
- maxPositions: you may only lower it.
- tradeVolatile: you may only turn it off.
- expertBias: multiply an expert's say in every regime by 0.5-1.5, for experts whose hit rates or behaviour warrant it. Leave the list empty when the learned weights look right.
- pauseMinutes: pause new entries (0-240) when conditions are plainly hostile, for example a danger reading or a run of losses in the current regime.

Use null for any setting that should stay as it is; making no changes is often the right answer, especially with few trades. Say in the assessment, in at most 120 plain words, what the evidence shows and why you changed what you changed. Be honest about how little a small sample proves. Never promise profits: the market can move against any model.`;

function describeError(err: unknown): string {
  if (err instanceof Anthropic.AuthenticationError) return 'the Anthropic API key was refused — check it in Settings → AI';
  if (err instanceof Anthropic.PermissionDeniedError) return `this API key may not use that model (${err.message})`;
  if (err instanceof Anthropic.NotFoundError) return `model not found — pick another in Settings → AI (${err.message})`;
  if (err instanceof Anthropic.RateLimitError) return 'Anthropic rate limit reached — the next review will try again';
  if (err instanceof Anthropic.BadRequestError) return `the request was refused: ${err.message}`;
  if (err instanceof Anthropic.APIConnectionError) return 'could not reach the Anthropic API';
  if (err instanceof Anthropic.APIError) return `Anthropic API error ${err.status ?? ''}: ${err.message}`.trim();
  return err instanceof Error ? err.message : String(err);
}

/**
 * Claude as the AI's reviewer, through the official SDK. In the browser build
 * the key stays in that browser and requests go straight to Anthropic.
 *
 * Server-side refusal fallbacks are on: if the chosen model declines a
 * review, Anthropic re-runs it on its recommended fallback model rather
 * than returning nothing.
 */
export function createClaudeReviewer(apiKey: string, options: { browser?: boolean; baseURL?: string } = {}): AiReviewClient {
  const client = new Anthropic({
    apiKey,
    dangerouslyAllowBrowser: options.browser === true,
    maxRetries: 2,
    ...(options.baseURL ? { baseURL: options.baseURL } : {}),
  });
  return {
    async review(input: ReviewInput, model: string): Promise<ReviewResult> {
      const chosen = model || DEFAULT_REVIEW_MODEL;
      // Server-side refusal fallbacks are documented for the Opus and Fable line; other models go without.
      const fallback: { betas?: Anthropic.Beta.AnthropicBeta[]; fallbacks?: 'default' } = /^claude-(opus-5|fable-5)/.test(chosen)
        ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' }
        : {};
      let response;
      try {
        response = await client.beta.messages.parse({
          model: chosen,
          max_tokens: 16000,
          ...fallback,
          thinking: { type: 'adaptive' },
          output_config: { format: betaZodOutputFormat(ReviewSchema) },
          system: SYSTEM,
          messages: [{ role: 'user', content: `Review the model now. Its state, as JSON:\n\n${JSON.stringify(input)}` }],
        });
      } catch (err) {
        throw new Error(describeError(err));
      }
      if (response.stop_reason === 'refusal') throw new Error('Claude declined this review, and so did the fallback model');
      if (response.stop_reason === 'max_tokens') throw new Error('the review ran out of room before it finished');
      const parsed = response.parsed_output;
      if (!parsed) throw new Error('Claude returned no usable review');
      const orUndefined = <T>(v: T | null): T | undefined => (v === null ? undefined : v);
      const suggestion: ReviewSuggestion = {
        assessment: parsed.assessment,
        minProbability: orUndefined(parsed.minProbability),
        riskPercent: orUndefined(parsed.riskPercent),
        slAtr: orUndefined(parsed.slAtr),
        rrMin: orUndefined(parsed.rrMin),
        rrMax: orUndefined(parsed.rrMax),
        maxPositions: orUndefined(parsed.maxPositions),
        tradeVolatile: orUndefined(parsed.tradeVolatile),
        expertBias: parsed.expertBias,
        pauseMinutes: orUndefined(parsed.pauseMinutes),
      };
      return {
        suggestion,
        model: response.model,
        inputTokens: response.usage?.input_tokens ?? null,
        outputTokens: response.usage?.output_tokens ?? null,
      };
    },
  };
}
