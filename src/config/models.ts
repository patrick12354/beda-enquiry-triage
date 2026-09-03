/**
 * Model tiering.
 *
 * Everything goes through OpenRouter, so a model is a config string rather than
 * an SDK dependency. That buys three things: one billing relationship, the
 * ability to re-tier a task by editing this file instead of shipping code, and
 * a single HTTP shape for every model in the system.
 *
 * Prices below are USD per 1M tokens, taken from OpenRouter at time of writing.
 * They are recorded here because the tiering argument is only meaningful with
 * real numbers attached -- see docs/DESIGN.md section 6.
 */

export interface ModelSpec {
  id: string;
  inputPerMTok: number;
  outputPerMTok: number;
  note: string;
}

export const MODELS = {
  /** Tier 1. Triage every enquiry that survives the pre-filter. */
  triage: {
    id: "deepseek/deepseek-v4-flash-0731",
    inputPerMTok: 0.065,
    outputPerMTok: 0.18,
    note: "High volume, low stakes, output is schema-constrained and verified.",
  },
  /** Tier 2. Structured extraction once triage says the enquiry is real. */
  extract: {
    id: "deepseek/deepseek-v4-flash-0731",
    inputPerMTok: 0.065,
    outputPerMTok: 0.18,
    note: "Same model, stricter schema. Escalates when the grounding check fails.",
  },
  /**
   * Tier 3. Used when tier 1/2 is uncertain, or when the enquiry looks like
   * real client demand. Better instruction-following is worth ~17x on the ~10%
   * of traffic that actually carries revenue.
   */
  escalated: {
    id: "deepseek/deepseek-v4-pro-0813",
    inputPerMTok: 1.1154,
    outputPerMTok: 3.3462,
    note: "Stronger reasoning for the enquiries where being wrong costs money.",
  },
  /**
   * Tier 4. Drafting replies in BEDA's voice. Brand tone is the product here
   * ("The Power of Good Advice"), and every draft is read by a human before it
   * goes anywhere, so this is a small, bounded spend.
   */
  draft: {
    id: "deepseek/deepseek-v4-pro-0813",
    inputPerMTok: 1.1154,
    outputPerMTok: 3.3462,
    note: "Voice matters more than cost; volume is capped by the approval queue.",
  },
} as const satisfies Record<string, ModelSpec>;

export type Tier = keyof typeof MODELS;

/**
 * Ordered fallback chain per tier, used when a provider errors or returns
 * unparseable output.
 *
 * A deliberate trade-off worth naming: this is a SINGLE-VENDOR chain. A
 * DeepSeek-wide outage takes out every tier at once, where a cross-vendor chain
 * would not. We accept that because of what happens next -- the pipeline
 * degrades to a human triage queue with a *tighter* 60-minute SLA rather than
 * guessing or dropping anything (see pipeline/run.ts). The failure mode is
 * "slower, staffed by people", not "wrong".
 *
 * If BEDA later wants cross-vendor cover, it is one line per chain here and no
 * other change anywhere in the system. That portability is most of the reason
 * for putting a gateway in front in the first place.
 */
export const FALLBACKS: Record<Tier, readonly string[]> = {
  triage: ["deepseek/deepseek-v4-flash-0731", "deepseek/deepseek-v4-pro-0813"],
  extract: ["deepseek/deepseek-v4-flash-0731", "deepseek/deepseek-v4-pro-0813"],
  escalated: ["deepseek/deepseek-v4-pro-0813", "deepseek/deepseek-v4-flash-0731"],
  draft: ["deepseek/deepseek-v4-pro-0813", "deepseek/deepseek-v4-flash-0731"],
};

/** Hard caps. Exceeding one is a bug, and should page rather than silently bill. */
export const LIMITS = {
  maxInputChars: 12_000,
  maxOutputTokens: 800,
  perEnquiryUsdCeiling: 0.05,
  dailyUsdCeiling: 25,
  requestTimeoutMs: 20_000,
} as const;

export function estimateUsd(spec: ModelSpec, inTok: number, outTok: number): number {
  return (inTok * spec.inputPerMTok + outTok * spec.outputPerMTok) / 1_000_000;
}
