import type { Anthropic } from "@anthropic-ai/sdk";

// What one model call cost (slices 4.3 and 4.4): the checker's review and a goal's brief are
// each one call to Claude Opus 5.5 with server-side refusal fallbacks, so a call may run on more
// than one model. Every model it ran on is counted at its own list price.

/** Claude Opus 5.5: the model of one-call jobs. */
export const ONE_CALL_MODEL = "claude-opus-5-5";

/** List price of a model, in millionths of a dollar per token. */
export interface Price {
  inputPerToken: number;
  outputPerToken: number;
}

/** List prices of `ONE_CALL_MODEL` ($4 and $20 per million tokens), in millionths of a dollar. */
export const ONE_CALL_PRICE_MICROS: Price = { inputPerToken: 4, outputPerToken: 20 };
/** The highest of the prices below, for any other model or one not named. */
const HIGHEST_PRICE: Price = { inputPerToken: 5, outputPerToken: 25 };

/** List prices of the models a call may run on: the model and its fallbacks. */
const PRICES = new Map<string, Price>([
  [ONE_CALL_MODEL, ONE_CALL_PRICE_MICROS],
  ["claude-opus-5", HIGHEST_PRICE],
  ["claude-opus-4-8", HIGHEST_PRICE],
]);

/** What a model's tokens cost; an unknown model at the highest price. */
export function priceOf(model: string | null): Price {
  return (model === null ? undefined : PRICES.get(model)) ?? HIGHEST_PRICE;
}

/** Characters per token for estimating a call that failed after it was sent. */
const CHARACTERS_PER_TOKEN = 3.5;

/** Tokens one model used in a call. */
export interface ModelUsage {
  /** Null when not known: priced at the highest. */
  model: string | null;
  inputTokens: number;
  outputTokens: number;
}

export interface CallUsage {
  inputTokens: number;
  outputTokens: number;
  /** The model the totals are priced at: `ONE_CALL_MODEL` when not given, the highest when null. */
  model?: string | null;
  /**
   * Each model's part when the API reports them (a refusal retried on a fallback model runs
   * two): when present, these are what is counted, each at its own model's price.
   */
  iterations?: ModelUsage[];
}

function costOf(part: ModelUsage): number {
  const price = priceOf(part.model);
  return part.inputTokens * price.inputPerToken + part.outputTokens * price.outputPerToken;
}

/** What a call cost at list price, in millionths of a dollar: every model it ran on. */
export function callCostMicros(usage: CallUsage | null): number {
  if (usage === null) return 0;
  if (usage.iterations !== undefined && usage.iterations.length > 0) {
    return usage.iterations.reduce((sum, part) => sum + costOf(part), 0);
  }
  return costOf({
    model: usage.model === undefined ? ONE_CALL_MODEL : usage.model,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
  });
}

/**
 * What a call that failed after it was sent is counted at, since the API may have run it
 * without answering: its input at about 3.5 characters a token, at the highest input price.
 * An over-count keeps the job under its cap; 0 would let failures spend unseen.
 */
export function estimatedUsage(characters: number): CallUsage {
  return {
    inputTokens: Math.ceil(characters / CHARACTERS_PER_TOKEN),
    outputTokens: 0,
    model: null,
  };
}

/** Each model's part of a response's usage, when the API reports them. */
function iterationsOf(
  iterations: Anthropic.Beta.BetaIterationsUsage | null | undefined,
): ModelUsage[] | undefined {
  if (iterations === null || iterations === undefined || iterations.length === 0) return undefined;
  return iterations.map((part) => ({
    // A compaction names no model; a sampling may not either.
    model: "model" in part ? (part.model ?? null) : null,
    inputTokens: part.input_tokens,
    outputTokens: part.output_tokens,
  }));
}

/** A response's usage, each model it ran on kept when the API reports them. */
export function usageOf(response: Anthropic.Beta.BetaMessage): CallUsage {
  const iterations = iterationsOf(response.usage.iterations);
  return {
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
    // Another model's answer is priced as that model's (an unknown one at the highest).
    ...(response.model === ONE_CALL_MODEL ? {} : { model: response.model }),
    ...(iterations === undefined ? {} : { iterations }),
  };
}
