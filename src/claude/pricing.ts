/**
 * Pricing, in USD per million tokens.
 *
 * The Models API reports capabilities but not prices, so prices live here. Models
 * not in this table get a family-based estimate, which the admin panel labels as
 * such — a new model is often priced differently from its predecessor (Opus 5.5
 * launched cheaper than Opus 5), so update this table when one ships.
 *
 * Source: https://platform.claude.com/docs/en/about-claude/pricing — checked 2026-10-01.
 */

export interface Pricing {
  inputPerMTok: number;
  outputPerMTok: number;
  /** Cache hits as a fraction of the input price. 0.1 on most models. */
  cacheReadMultiplier: number;
  /** True when the price was inferred from the model family, not looked up. */
  estimated: boolean;
}

/** 5-minute cache writes. Uniform across models; this bot only uses the 5-minute TTL. */
export const CACHE_WRITE_MULTIPLIER = 1.25;

const STANDARD_CACHE_READ = 0.1;

/** Published first-party API list prices: [input, output, cache-read multiplier]. */
const KNOWN_PRICES: Record<string, [input: number, output: number, cacheRead: number]> = {
  "claude-fable-5-1": [10, 50, 0.025],
  "claude-mythos-5-1": [10, 50, 0.025],
  "claude-fable-5": [10, 50, STANDARD_CACHE_READ],
  "claude-mythos-5": [10, 50, STANDARD_CACHE_READ],
  "claude-opus-5-5": [4, 20, 0.05],
  "claude-opus-5": [5, 25, STANDARD_CACHE_READ],
  "claude-opus-4-8": [5, 25, STANDARD_CACHE_READ],
  "claude-opus-4-7": [5, 25, STANDARD_CACHE_READ],
  "claude-opus-4-6": [5, 25, STANDARD_CACHE_READ],
  "claude-opus-4-5": [5, 25, STANDARD_CACHE_READ],
  // Sonnet 5's launch price was introductory, then made permanent.
  "claude-sonnet-5-5": [2, 10, STANDARD_CACHE_READ],
  "claude-sonnet-5": [2, 10, STANDARD_CACHE_READ],
  "claude-sonnet-4-6": [3, 15, STANDARD_CACHE_READ],
  "claude-sonnet-4-5": [3, 15, STANDARD_CACHE_READ],
  "claude-haiku-4-5": [1, 5, STANDARD_CACHE_READ],
};

/**
 * Fallback when only the family is known. Each uses the family's highest recent
 * price and the standard cache rate, so an unpriced model's spend is over- rather
 * than under-reported — the daily cost limit errs toward stopping early.
 */
const FAMILY_ESTIMATES: Record<string, [input: number, output: number]> = {
  fable: [10, 50],
  mythos: [10, 50],
  opus: [5, 25],
  sonnet: [3, 15],
  haiku: [1, 5],
};
const UNKNOWN_FAMILY_ESTIMATE: [number, number] = [10, 50];

export function modelFamily(id: string): string {
  return id.match(/^claude-(fable|mythos|opus|sonnet|haiku)\b/)?.[1] ?? "other";
}

export function pricingFor(id: string): Pricing {
  // Match the exact id, or the id plus a date snapshot suffix — never a bare
  // prefix, or "claude-opus-5" would silently price "claude-opus-5-5".
  for (const [key, [input, output, cacheRead]] of Object.entries(KNOWN_PRICES)) {
    if (id === key || new RegExp(`^${escapeRegExp(key)}-\\d{8}$`).test(id)) {
      return { inputPerMTok: input, outputPerMTok: output, cacheReadMultiplier: cacheRead, estimated: false };
    }
  }
  const [input, output] = FAMILY_ESTIMATES[modelFamily(id)] ?? UNKNOWN_FAMILY_ESTIMATE;
  return { inputPerMTok: input, outputPerMTok: output, cacheReadMultiplier: STANDARD_CACHE_READ, estimated: true };
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
