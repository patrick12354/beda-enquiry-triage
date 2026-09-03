import { z } from "zod";
import type { LlmPort, LlmRequest, LlmResult, OutputSchema } from "./llm.js";
import { MODELS } from "../config/models.js";

/**
 * A deterministic stand-in for the two inference calls, so the local demo can
 * accept ARBITRARY text with no API key and no network.
 *
 * This is not a model and does not pretend to be one. It is keyword scoring and
 * regex, and it is labelled "simulated" everywhere it surfaces in the UI. It
 * exists for one reason: the interesting part of this system is what happens
 * AFTER inference -- grounding, identity resolution, the gate, the approval
 * boundary -- and none of that should require a credit card to demonstrate.
 *
 * It is also a fair test of the port boundary. If the pipeline works identically
 * against regex and against DeepSeek, the pipeline genuinely does not depend on
 * the model, which is the claim the design makes.
 *
 * Every span it returns is a real substring of the source, so extractions pass
 * the grounding check honestly rather than by exemption.
 */

const CLIENT_SIGNALS: Array<[RegExp, number]> = [
  [/\b(we|our team|our company|we're|we are)\b.{0,40}\b(hiring|hire|need|looking for|want to put on|scaling|building)\b/i, 3],
  [/\b(appointment setters?|closers?|sdrs?|bdrs?|sales (people|reps|staff)|marketers?)\b/i, 1.5],
  [/\b(headcount|full[- ]time equivalents?|fte|onboard|ramp)\b/i, 2],
  [/\b(supply|provide|source|place|second)\b.{0,25}\b(people|staff|talent|team)\b/i, 2.5],
  [/\b(quote|pricing|rates?|proposal|what does it cost|how much)\b/i, 1],
  [/\b(director|founder|ceo|gm|head of|general manager)\b/i, 1],
];

const CANDIDATE_SIGNALS: Array<[RegExp, number]> = [
  [/\b(i|i'm|i am|my)\b.{0,40}\b(apply|applying|application|cv|resume|portfolio|experience|looking for (a )?(role|job|work))\b/i, 3],
  [/\b(join (a|your|the) team|work with you|relocate|move to bali|based in bali)\b/i, 3],
  [/\b(current role|current location|years? of experience)\b/i, 2],
  [/\bsales or marketing\?/i, 3],
  [/\b(linkedin|instagram)\b/i, 0.5],
];

const SUPPORT_SIGNALS: Array<[RegExp, number]> = [
  [/\b(payroll|payslip|salary|allowance|reimburse|invoice|paid short|underpaid)\b/i, 3],
  [/\b(visa|kitas|permit|contract|hr|leave request|sick)\b/i, 2],
  [/\b(issue|problem|not working|error|help with|can someone check)\b/i, 1.5],
];

const SPAM_SIGNALS: Array<[RegExp, number]> = [
  [/\b(seo|backlinks?|domain authority|google ranking|guest post|link building)\b/i, 4],
  [/\b(crypto|forex|bitcoin|casino|loan offer)\b/i, 4],
  [/\b(we can (10x|double|triple)|guaranteed (leads|results|traffic))\b/i, 3],
];

const PARTNERSHIP_SIGNALS: Array<[RegExp, number]> = [
  [/\b(partnership|collaborat|referral|podcast|press|interview|feature you|coworking|venue|sponsor)\b/i, 2.5],
];

function score(text: string, signals: Array<[RegExp, number]>): number {
  return signals.reduce((acc, [re, w]) => acc + (re.test(text) ? w : 0), 0);
}

/** Pull the first regex match and return the matched text as its own span. */
function grab(source: string, re: RegExp): { value: string; sourceSpan: string } | null {
  const m = source.match(re);
  if (!m) return null;
  const value = (m[1] ?? m[0]).trim();
  if (!value) return null;
  // The span is the whole match, so it is always literally present in the source.
  return { value, sourceSpan: m[0].trim() };
}

/** Field label from a rendered form line, e.g. "Current Role: SDR at Acme". */
function grabField(source: string, label: RegExp): { value: string; sourceSpan: string } | null {
  const re = new RegExp(`^(${label.source})\\s*:\\s*(.+)$`, "im");
  const m = source.match(re);
  if (!m || !m[2]) return null;
  const value = m[2].trim();
  if (!value || value.toLowerCase() === "n/a") return null;
  return { value, sourceSpan: m[0].trim() };
}

export class HeuristicLlm implements LlmPort {
  async complete<T>(req: LlmRequest & { schema: OutputSchema<T> }): Promise<LlmResult<T>> {
    const src = req.untrustedUserContent;
    const data =
      req.schemaName === "Classification" ? this.classify(src) : this.extract(src);
    return {
      data: req.schema.parse(data),
      modelUsed: `simulated/${MODELS[req.tier].id}`,
      usdSpent: 0,
      latencyMs: 2,
      attempts: 1,
    };
  }

  private classify(src: string) {
    const scores = {
      client_new_business: score(src, CLIENT_SIGNALS),
      candidate_application: score(src, CANDIDATE_SIGNALS),
      support: score(src, SUPPORT_SIGNALS),
      spam: score(src, SPAM_SIGNALS),
      partnership: score(src, PARTNERSHIP_SIGNALS),
    };

    // The Wix form is a candidate channel; treat that as strong prior evidence,
    // exactly as a well-prompted model should.
    if (/^channel: wix_form$/im.test(src)) scores.candidate_application += 2.5;

    const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
    const [topIntent, topScore] = ranked[0] as [string, number];
    const runnerUp = (ranked[1]?.[1] ?? 0) as number;

    // No signal at all, or two intents neck and neck, means we genuinely do not
    // know -- and saying so is the useful answer.
    if (topScore < 2 || topScore - runnerUp < 1) {
      return {
        intent: "unclear" as const,
        confidence: 0.4,
        rationale:
          topScore < 2
            ? "No clear signal for either side of the marketplace."
            : `Signals split between ${ranked[0]?.[0]} and ${ranked[1]?.[0]}.`,
        evidence: src.slice(0, 160).trim(),
      };
    }

    // Map the raw score onto a confidence, capped well below 1. A heuristic
    // should never claim certainty, and the gate's floors are calibrated for
    // honest numbers.
    const confidence = Math.min(0.94, 0.55 + (topScore - runnerUp) * 0.09);
    const evidence = this.evidenceFor(src, topIntent);

    return {
      intent: topIntent as
        | "client_new_business"
        | "candidate_application"
        | "support"
        | "spam"
        | "partnership",
      confidence: Number(confidence.toFixed(2)),
      rationale: `Keyword signals favour ${topIntent} (${topScore.toFixed(1)} vs ${runnerUp.toFixed(1)}).`,
      evidence: evidence.slice(0, 380),
    };
  }

  private evidenceFor(src: string, intent: string): string {
    const table: Record<string, Array<[RegExp, number]>> = {
      client_new_business: CLIENT_SIGNALS,
      candidate_application: CANDIDATE_SIGNALS,
      support: SUPPORT_SIGNALS,
      spam: SPAM_SIGNALS,
      partnership: PARTNERSHIP_SIGNALS,
    };
    for (const [re] of table[intent] ?? []) {
      const m = src.match(re);
      if (m) return m[0].trim();
    }
    return src.slice(0, 160).trim();
  }

  private extract(src: string) {
    const roleWords =
      "appointment setters?|closers?|sdrs?|bdrs?|business development|sales (?:people|reps|representatives|staff)|content creators?|designers?|marketing coordinators?|digital marketers?|marketers?";

    return {
      contactName:
        grabField(src, /full name|from name/) ??
        grab(src, /\b(?:regards|thanks|cheers|best),?\s*\n+\s*([A-Z][a-z]+(?: [A-Z][a-z]+)?)/),
      email: grab(src, /[\w.+-]+@[\w-]+\.[\w.-]+/),
      phone: grabField(src, /from phone|phone|mobile|whatsapp/),
      companyName:
        grab(src, /\b(?:we(?:'re| are)|this is|i'm from|company:)\s+([A-Z][\w&'-]*(?:\s+[A-Z][\w&'-]*){0,3})/) ??
        grab(src, /\b([A-Z][\w&'-]*(?:\s+[A-Z][\w&'-]*){0,3}\s+(?:Pty Ltd|Ltd|Group|Digital|Partners|Holdings))\b/),
      companyWebsite: grab(src, /\b(?:https?:\/\/)?(?:www\.)?[\w-]+\.(?:com|com\.au|io|co|id)(?:\/\S*)?/),
      track: grabField(src, /sales or marketing\?/) ?? grab(src, /\b(sales|marketing)\s+side\b/i),
      currentLocation: grabField(src, /current location|location|based in/),
      currentRole: grabField(src, /current role|role|position/),
      rolesSought: grab(src, new RegExp(`\\b(${roleWords})\\b`, "i")),
      headcount: grab(src, new RegExp(`\\b(?:around |about |up to )?(\\d{1,3})\\s+(?:more )?(?:people|staff|${roleWords})`, "i")),
      timeline: grab(src, /\b(?:start(?:ing)?|from|by|in)\s+(?:early |mid |late )?(?:Q[1-4]|January|February|March|April|May|June|July|August|September|October|November|December|next (?:month|quarter|year)|asap)\b/i),
      budget: grab(src, /\b(?:AUD|IDR|USD|\$|Rp)\s?[\d,.]+(?:\s?(?:k|m|million))?/i),
      issueSummary:
        score(src, SUPPORT_SIGNALS) >= 3
          ? grab(src, /[^.\n]*\b(?:payroll|payslip|allowance|invoice|visa|kitas|paid short|not working|error)\b[^.\n]*/i)
          : null,
    };
  }
}

/** Narrow helper so the server can report which brain is in use. */
export type LlmMode = "live" | "simulated";

export function describeMode(mode: LlmMode): string {
  return mode === "live"
    ? `live — ${MODELS.triage.id} / ${MODELS.escalated.id} via OpenRouter`
    : "simulated — deterministic keyword + regex stand-in, no network";
}

/** Kept so this module owns its own zod import cleanly for schema parsing. */
export const _z = z;
