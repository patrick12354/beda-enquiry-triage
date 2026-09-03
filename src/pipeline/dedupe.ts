import type { CrmPort } from "../ports/crm.js";
import type { RawEnquiry } from "../domain/schema.js";

/**
 * Identity resolution. Deterministic, tiered, and deliberately conservative.
 *
 * Duplicates arrive constantly and for boring reasons: someone submits the Wix
 * form twice, then emails as well; a webhook is redelivered; a candidate
 * applies in March and again in September. Three defences, strongest first:
 *
 *  1. externalId  -- the provider's own message id. Exact, cheap, catches
 *                    webhook redelivery, which is the most common case.
 *  2. email/phone -- normalised exactly (gmail dots, plus-tags, E.164). Exact
 *                    match attaches to the existing contact.
 *  3. fuzzy       -- name + company similarity. NEVER auto-merges. It only
 *                    raises candidates for a human, because an incorrect merge
 *                    of two client companies is expensive and manual to undo.
 *
 * Note what is absent: no model. Asking an LLM "are these the same person" is
 * non-deterministic, unauditable and worse than string normalisation at the job.
 */

export interface DedupeResult {
  /** Set when we are certain: replay of a message we already processed. */
  replayOf: string | null;
  /** Set when this belongs to a known contact. */
  contactId: string | null;
  /** >1 means a person decides; the gate escalates. */
  ambiguousCompanyMatches: number;
  reasons: string[];
}

export function normaliseEmail(raw: string | null): string | null {
  if (!raw) return null;
  const trimmed = raw.trim().toLowerCase();
  const [local, domain] = trimmed.split("@");
  if (!local || !domain) return null;
  let user = local.split("+")[0] ?? local;
  // Gmail ignores dots; treating them as significant creates phantom duplicates.
  if (domain === "gmail.com" || domain === "googlemail.com") user = user.replaceAll(".", "");
  return `${user}@${domain === "googlemail.com" ? "gmail.com" : domain}`;
}

export function normalisePhone(raw: string | null, defaultCc = "62"): string | null {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, "");
  if (digits.length < 8) return null;
  if (raw.trim().startsWith("+")) return `+${digits}`;
  // Indonesian and Australian local formats both start 0; both are in scope.
  if (digits.startsWith("0")) return `+${defaultCc}${digits.slice(1)}`;
  return `+${digits}`;
}

export function domainOf(website: string | null | undefined): string | null {
  if (!website) return null;
  const m = website.trim().toLowerCase().match(/^(?:https?:\/\/)?(?:www\.)?([^/\s]+)/);
  return m?.[1] ?? null;
}

export async function resolveIdentity(
  enquiry: RawEnquiry,
  extracted: { email?: string; companyName?: string; companyWebsite?: string },
  crm: CrmPort,
  seenExternalIds: Set<string>,
): Promise<DedupeResult> {
  const reasons: string[] = [];

  if (seenExternalIds.has(enquiry.externalId)) {
    return {
      replayOf: enquiry.externalId,
      contactId: null,
      ambiguousCompanyMatches: 0,
      reasons: ["replay_of_processed_external_id"],
    };
  }

  const email = normaliseEmail(extracted.email ?? enquiry.fromEmail);
  const phone = normalisePhone(enquiry.fromPhone);
  const contact = await crm.findContact({ email, phone });
  if (contact) reasons.push(`matched_contact:${contact.id}`);

  const companyMatches = extracted.companyName
    ? await crm.findCompanies({
        domain: domainOf(extracted.companyWebsite) ?? (email ? (email.split("@")[1] ?? null) : null),
        name: extracted.companyName,
      })
    : [];

  // An exact domain hit is decisive; several weak name hits are not.
  const decisive = companyMatches.filter((c) => c.score >= 0.9);
  const ambiguous = decisive.length === 1 ? 0 : companyMatches.filter((c) => c.score >= 0.5).length;
  if (ambiguous > 1) reasons.push(`ambiguous_company:${ambiguous}`);

  return {
    replayOf: null,
    contactId: contact?.id ?? null,
    ambiguousCompanyMatches: ambiguous,
    reasons,
  };
}
