import type { RawEnquiry } from "../domain/schema.js";

/**
 * Deterministic pre-filter. Runs before any token is spent.
 *
 * Roughly half of what hits a public Wix form is link-farm spam or agency cold
 * outreach, and it is recognisable without a model: too many links, a known
 * bad domain, an empty body, a tripped honeypot. Paying a model to read it is
 * both wasteful and a small injection surface for no benefit.
 */

const SPAM_DOMAINS = new Set([
  "seo-boost.example",
  "linkbuilding.example",
  "cheapleads.example",
]);

// Phrases that are unambiguous outbound-agency spam. Kept deliberately short
// and reviewed by a human monthly -- a keyword list that grows without review
// eventually eats a real customer.
const SPAM_PHRASES = [
  "improve your google ranking",
  "we can 10x your leads",
  "buy backlinks",
  "guest post opportunity",
  "increase your domain authority",
];

export interface PrefilterVerdict {
  drop: boolean;
  reasons: string[];
  /** Cost avoided by not calling a model. Reported so the saving is visible. */
  skippedInference: boolean;
}

export function prefilter(e: RawEnquiry): PrefilterVerdict {
  const reasons: string[] = [];
  const body = e.body.toLowerCase();

  if (e.honeypotTripped) reasons.push("honeypot");
  if (body.trim().length < 15 && Object.keys(e.formFields).length === 0) reasons.push("empty_body");

  const domain = e.fromEmail?.split("@")[1]?.toLowerCase();
  if (domain && SPAM_DOMAINS.has(domain)) reasons.push(`blocklisted_domain:${domain}`);

  const links = (e.body.match(/https?:\/\//g) ?? []).length;
  if (links >= 5) reasons.push(`link_flood:${links}`);

  for (const p of SPAM_PHRASES) {
    if (body.includes(p)) reasons.push(`spam_phrase:${p}`);
  }

  return { drop: reasons.length > 0, reasons, skippedInference: reasons.length > 0 };
}
