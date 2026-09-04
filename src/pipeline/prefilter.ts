import type { WorkItem } from "../domain/schema.js";

/**
 * Deterministic pre-filter. Runs before a single token is spent.
 *
 * Two jobs, and the second is the important one.
 *
 * Cost: a bought-lead-list pitch is recognisable without a model, and paying to
 * have one read is waste.
 *
 * Attack surface: every item that reaches the model is text written by a
 * stranger. Items that are obviously junk are the most likely to be carrying a
 * prompt injection, and the cheapest defence against an injection is not
 * feeding it to a model at all.
 *
 * The list is kept short and blunt on purpose. A keyword list that grows
 * without review eventually eats a real customer, and the failure is silent —
 * nobody reports the enquiry they never knew arrived. Anything the pre-filter
 * drops is retained in quarantine and is reversible.
 */

/** Unambiguous commercial junk. Each phrase is one that no BEDA customer writes. */
const SPAM_PHRASES = [
  "cryptocurrency payment",
  "crypto payment",
  "bitcoin payment",
  "buy backlinks",
  "improve your google ranking",
  "increase your domain authority",
  "guest post opportunity",
];

/** "50,000 CEO leads", "10,000 verified contacts" — a list vendor, every time. */
const LEAD_LIST = /\b(buy|purchase)\b[^.]{0,40}\b[\d,]{4,}\b[^.]{0,30}\b(leads?|contacts?|emails?|records?)\b/i;

/**
 * Text that is trying to talk to the model rather than to BEDA.
 *
 * This is defence in depth, not the primary control. The primary control is
 * structural: the model in this path has no tools, no write credentials and a
 * closed output schema, so the worst a successful injection achieves is a wrong
 * label, which the deterministic gate still has to accept. Flagging it here
 * means a human is told an attempt was made, which is worth knowing.
 */
const INJECTION_MARKERS = [
  /ignore (all |any )?(previous|prior|above) instructions/i,
  /disregard (the |your )?(system|previous) (prompt|instructions)/i,
  /\byou are now\b.{0,30}\b(assistant|ai|model|dan)\b/i,
  /\b(system|developer) (prompt|message)\s*[:>]/i,
  /<\|?(im_start|im_end|system)\|?>/i,
  /\bmark this (as )?(urgent|high priority|approved)\b/i,
  /\bsend (this |the )?(reply|email) (immediately|without approval)\b/i,
];

export interface PrefilterVerdict {
  drop: boolean;
  reasons: string[];
  /** Injection attempts are flagged even when the item is NOT dropped. */
  injectionFlags: string[];
  /** Reported so the saving from not calling a model is visible, not asserted. */
  skippedInference: boolean;
}

export function prefilter(item: WorkItem): PrefilterVerdict {
  const reasons: string[] = [];
  const injectionFlags: string[] = [];

  const haystack = [item.subject ?? "", item.body, ...item.attachments.map((a) => a.text)]
    .join("\n")
    .toLowerCase();

  if (haystack.trim().length < 15) reasons.push("empty_body");

  for (const p of SPAM_PHRASES) {
    if (haystack.includes(p)) reasons.push(`spam_phrase:${p}`);
  }
  if (LEAD_LIST.test(haystack)) reasons.push("bought_lead_list_offer");

  const links = (item.body.match(/https?:\/\//g) ?? []).length;
  if (links >= 5) reasons.push(`link_flood:${links}`);

  for (const re of INJECTION_MARKERS) {
    const m = haystack.match(re);
    if (m) injectionFlags.push(m[0].slice(0, 80));
  }

  return {
    drop: reasons.length > 0,
    reasons,
    injectionFlags,
    skippedInference: reasons.length > 0,
  };
}

/**
 * Does the body claim an attachment that never arrived?
 *
 * E007 says "My portfolio is attached" and the pack contains no portfolio. That
 * is not an error to swallow: the applicant believes they sent something, and a
 * reply that ignores it reads as carelessness.
 */
export function claimsMissingAttachment(item: WorkItem): boolean {
  const claims = /\b(attach(ed|ment)|enclosed|please find|i have sent)\b/i.test(item.body);
  return claims && item.attachments.filter((a) => a.resolved).length === 0;
}
