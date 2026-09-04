import type { Conflict, CrmMatch, CrmRow, Entity, Extraction, WorkItem } from "../domain/schema.js";
import { plainValues } from "./grounding.js";

/**
 * Identity resolution, duplicate detection and conflict resolution.
 *
 * Deterministic, tiered, and conservative on purpose. There is no model in this
 * file, and that is a design position rather than an omission: asking an LLM
 * "are these the same company?" is non-reproducible, unauditable, and worse at
 * the job than normalisation plus a similarity score. When a merge is wrong,
 * two customers' histories are welded together and separating them is manual.
 *
 * The supplied pack contains three distinct duplicate problems, and they need
 * three different answers:
 *
 *  1. C001 and C002 are the same organisation, twice, INSIDE the CRM export.
 *     Nothing the email pipeline does creates or fixes this. It is found by
 *     scanning the export against itself and reported as a data-quality defect
 *     with a proposed merge — proposed, never executed.
 *
 *  2. E001 and E002 are the same organisation writing in twice, through two
 *     addresses, spelling its own name two different ways. These must resolve
 *     to one opportunity, or BEDA quotes the same warehouse portfolio twice.
 *
 *  3. E009 and E010 are the same person correcting themself. This is not a
 *     duplicate at all — it is an amendment, and treating it as a duplicate
 *     would keep the wrong phone number.
 */

/** Domains where sharing a domain says nothing about sharing an employer. */
const GENERIC_DOMAINS = new Set([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "yahoo.com",
  "icloud.com",
  "proton.me",
  "examplemail.test",
]);

/** Mailboxes that belong to a function, not a person. Never used as a person key. */
const ROLE_LOCALPARTS = new Set([
  "info",
  "sales",
  "admin",
  "accounts",
  "facilities",
  "enquiries",
  "engineering",
  "alerts",
  "support",
  "hello",
  "contact",
  "noreply",
  "no-reply",
]);

export function normaliseEmail(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim().toLowerCase();
  const at = trimmed.lastIndexOf("@");
  if (at <= 0) return null;
  const local = trimmed.slice(0, at);
  const domain = trimmed.slice(at + 1);
  if (!local || !domain) return null;
  let user = local.split("+")[0] ?? local;
  // Gmail ignores dots. Treating them as significant invents duplicates.
  if (domain === "gmail.com" || domain === "googlemail.com") user = user.replaceAll(".", "");
  return `${user}@${domain === "googlemail.com" ? "gmail.com" : domain}`;
}

export function emailDomain(raw: string | null | undefined): string | null {
  const e = normaliseEmail(raw);
  const d = e?.split("@")[1] ?? null;
  return d && !GENERIC_DOMAINS.has(d) ? d : null;
}

export function isRoleAddress(raw: string | null | undefined): boolean {
  const local = normaliseEmail(raw)?.split("@")[0];
  return local !== undefined && ROLE_LOCALPARTS.has(local);
}

/**
 * Australian mobile/landline normalisation to E.164.
 *
 * Worth doing properly: E009 gives 0411 999 120 and E010 corrects it to
 * 0411 999 102. Those differ by a transposition in the last two digits, so any
 * comparison that is loose about formatting has to be exact about digits.
 */
export function normalisePhone(raw: string | null | undefined, defaultCc = "61"): string | null {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, "");
  if (digits.length < 8) return null;
  if (raw.trim().startsWith("+")) return `+${digits}`;
  if (digits.startsWith("0")) return `+${defaultCc}${digits.slice(1)}`;
  return `+${digits}`;
}

const COMPANY_SUFFIXES =
  /\b(pty\.?\s*ltd\.?|pty\.?|ltd\.?|limited|inc\.?|incorporated|llc|plc|group|holdings|co\.?)\b/gi;

/** Strip legal suffixes and punctuation so "Hume Logistics Pty Ltd" ≈ "Hume Logistic". */
export function normaliseCompany(raw: string | null | undefined): string {
  if (!raw) return "";
  return raw
    .toLowerCase()
    .replace(COMPANY_SUFFIXES, " ")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Dice coefficient over character bigrams. Cheap, symmetric, and explainable. */
export function similarity(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const bigrams = (s: string) => {
    const out = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i++) {
      const k = s.slice(i, i + 2);
      out.set(k, (out.get(k) ?? 0) + 1);
    }
    return out;
  };
  const A = bigrams(a);
  const B = bigrams(b);
  let shared = 0;
  for (const [k, n] of A) shared += Math.min(n, B.get(k) ?? 0);
  const total = [...A.values()].reduce((x, y) => x + y, 0) + [...B.values()].reduce((x, y) => x + y, 0);
  return total === 0 ? 0 : (2 * shared) / total;
}

/** Above this a link is made automatically; below it, only proposed to a human. */
export const AUTO_LINK_FLOOR = 0.9;

/** ------------------------------------------------------------------
 *  Matching one item against the CRM export
 *  ------------------------------------------------------------------ */

export function matchCrm(
  item: WorkItem,
  extraction: Extraction,
  crm: CrmRow[],
): { matches: CrmMatch[]; best: CrmMatch | null; ambiguous: boolean } {
  const v = plainValues(extraction);
  const itemDomain = emailDomain(v.contactEmail ?? item.fromEmail);
  const itemEmail = normaliseEmail(v.contactEmail ?? item.fromEmail);
  const itemPhone = normalisePhone(v.contactPhone);
  const itemCompany = normaliseCompany(v.companyName);
  const itemContact = (v.contactName ?? item.fromName ?? "").toLowerCase().trim();

  const matches: CrmMatch[] = [];

  for (const row of crm) {
    const signals: string[] = [];
    let score = 0;

    if (itemEmail && normaliseEmail(row.email) === itemEmail) {
      score = Math.max(score, 1);
      signals.push("exact_email");
    }
    if (itemDomain && emailDomain(row.email) === itemDomain) {
      score = Math.max(score, 0.95);
      signals.push(`email_domain:${itemDomain}`);
    }
    if (itemPhone && normalisePhone(row.phone) === itemPhone) {
      score = Math.max(score, 0.95);
      signals.push("exact_phone");
    }

    const nameSim = similarity(itemCompany, normaliseCompany(row.company));
    if (nameSim >= 0.85) {
      score = Math.max(score, 0.8);
      signals.push(`company_name~${nameSim.toFixed(2)}`);
    } else if (nameSim >= 0.6) {
      score = Math.max(score, 0.55);
      signals.push(`company_name_weak~${nameSim.toFixed(2)}`);
    }

    if (itemContact && row.contact.toLowerCase() === itemContact) {
      // A matching person name on its own is weak — Australia has more than one
      // Amelia Grant — but it corroborates a domain or company hit.
      score = Math.min(1, score + (score > 0 ? 0.03 : 0));
      signals.push("contact_name");
    }

    if (score > 0) {
      matches.push({ crmId: row.id, company: row.company, score, signals });
    }
  }

  matches.sort((a, b) => b.score - a.score);
  const strong = matches.filter((m) => m.score >= AUTO_LINK_FLOOR);

  // Several strong hits is not ambiguity in this dataset — it is the CRM's own
  // duplication surfacing. C001 and C002 are one customer, so an enquiry from
  // Amelia Grant matching both is correct, not confusing. Ambiguity is when the
  // strong hits point at organisations that are NOT plausibly the same one.
  // Collapsing those two cases would send every Hume enquiry to a human forever.
  let ambiguous = false;
  for (let i = 0; i < strong.length; i++) {
    for (let j = i + 1; j < strong.length; j++) {
      const a = normaliseCompany(strong[i]!.company);
      const b = normaliseCompany(strong[j]!.company);
      if (similarity(a, b) < 0.8) ambiguous = true;
    }
  }

  return { matches, best: strong[0] ?? matches[0] ?? null, ambiguous };
}

/** ------------------------------------------------------------------
 *  Duplicates inside the CRM export itself
 *  ------------------------------------------------------------------ */

export interface CrmDuplicateGroup {
  crmIds: string[];
  reason: string;
  /** What a human is being asked to approve. Never applied automatically. */
  proposedSurvivor: string;
  proposedMerge: Record<string, string>;
}

/**
 * Scan the export against itself.
 *
 * C001 and C002 share a contact name, a location and an email DOMAIN, and their
 * company names differ only by a legal suffix and a plural. They are one
 * customer, recorded twice, at two pipeline stages — which means BEDA's pipeline
 * report currently double-counts them.
 *
 * The survivor is chosen by completeness (how many fields are populated), not
 * by id order, and the merge is a proposal. This function never mutates the CRM.
 */
export function findCrmDuplicates(crm: CrmRow[]): CrmDuplicateGroup[] {
  const groups: CrmDuplicateGroup[] = [];
  const claimed = new Set<string>();

  for (let i = 0; i < crm.length; i++) {
    const a = crm[i]!;
    if (claimed.has(a.id)) continue;
    const members = [a];

    for (let j = i + 1; j < crm.length; j++) {
      const b = crm[j]!;
      if (claimed.has(b.id)) continue;

      const signals: string[] = [];
      const domA = emailDomain(a.email);
      const domB = emailDomain(b.email);
      if (domA && domA === domB) signals.push("email_domain");
      if (a.contact && a.contact.toLowerCase() === b.contact.toLowerCase()) signals.push("contact");
      const sim = similarity(normaliseCompany(a.company), normaliseCompany(b.company));
      if (sim >= 0.8) signals.push(`company~${sim.toFixed(2)}`);
      if (a.location && a.location === b.location) signals.push("location");

      // Two independent strong signals, one of which must be identity-bearing.
      const identityBearing = signals.some((s) => s === "email_domain" || s.startsWith("company~"));
      if (signals.length >= 2 && identityBearing) {
        members.push(b);
        claimed.add(b.id);
        groups.push({
          crmIds: [a.id, b.id],
          reason: signals.join(" + "),
          proposedSurvivor: completeness(a) >= completeness(b) ? a.id : b.id,
          proposedMerge: mergeRows(a, b),
        });
      }
    }
    if (members.length > 1) claimed.add(a.id);
  }
  return groups;
}

function completeness(r: CrmRow): number {
  return Object.values(r).filter((v) => v.trim().length > 0).length;
}

/** Union of populated fields. Where both are populated and differ, both are kept. */
function mergeRows(a: CrmRow, b: CrmRow): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of Object.keys(a) as Array<keyof CrmRow>) {
    const x = a[key].trim();
    const y = b[key].trim();
    if (x && y && x !== y) out[key] = `${x}  |  ${y}   (conflict — human to choose)`;
    else out[key] = x || y;
  }
  return out;
}

/** ------------------------------------------------------------------
 *  Clustering items into entities, and resolving field conflicts
 *  ------------------------------------------------------------------ */

export interface EntityInput {
  item: WorkItem;
  extraction: Extraction;
}

/**
 * Group items that describe one organisation, then reconcile the fields where
 * the group disagrees with itself.
 *
 * Clustering key, strongest first: a non-generic email domain, then a phone
 * number, then a normalised company name above the similarity floor. Role
 * addresses (facilities@, info@) still carry a usable domain even though the
 * person behind them is unknown, which is exactly the E009/E010 case.
 */
export function clusterEntities(inputs: EntityInput[], crm: CrmRow[]): Entity[] {
  const entities: Entity[] = [];

  const keyFor = (i: EntityInput): { key: string; signal: string } | null => {
    const v = plainValues(i.extraction);
    const dom = emailDomain(v.contactEmail ?? i.item.fromEmail);
    if (dom) return { key: `domain:${dom}`, signal: `email_domain:${dom}` };
    const phone = normalisePhone(v.contactPhone);
    if (phone) return { key: `phone:${phone}`, signal: `phone:${phone}` };
    const company = normaliseCompany(v.companyName);
    if (company) return { key: `company:${company}`, signal: `company:${company}` };
    return null;
  };

  const buckets = new Map<string, { inputs: EntityInput[]; signals: Set<string> }>();
  for (const input of inputs) {
    const k = keyFor(input);
    // No usable key means no cluster. A singleton entity is the honest answer;
    // inventing a link from thin evidence is not.
    const key = k?.key ?? `item:${input.item.id}`;
    const bucket = buckets.get(key) ?? { inputs: [], signals: new Set<string>() };
    bucket.inputs.push(input);
    if (k) bucket.signals.add(k.signal);
    buckets.set(key, bucket);
  }

  let n = 0;
  for (const [key, bucket] of buckets) {
    n++;
    const ids = bucket.inputs.map((b) => b.item.id);
    const crmIds = new Set<string>();
    for (const b of bucket.inputs) {
      const { matches } = matchCrm(b.item, b.extraction, crm);
      for (const m of matches) if (m.score >= AUTO_LINK_FLOOR) crmIds.add(m.crmId);
    }

    const displayName =
      bucket.inputs
        .map((b) => plainValues(b.extraction).companyName)
        .find((c): c is string => Boolean(c)) ??
      key.replace(/^domain:/, "") ??
      ids.join(", ");

    const crmRows = crm.filter((r) => crmIds.has(r.id));
    entities.push({
      entityId: `ENT-${String(n).padStart(3, "0")}`,
      displayName,
      itemIds: ids,
      crmIds: [...crmIds],
      crmInternalDuplicates: findCrmDuplicates(crmRows)
        .map((g) => g.crmIds)
        .filter((g) => g.length > 1),
      conflicts: resolveConflicts(bucket.inputs),
      signals: [...bucket.signals],
    });
  }

  return entities;
}

/** Language that marks a message as an amendment to something said earlier. */
const CORRECTION_MARKERS = [
  /\bcorrect(ing|ion)?\b/i,
  /\bnot\b\s+[\d+][\d\s]*/i,
  /\bshould be\b/i,
  /\bapolog/i,
  /\bignore my (previous|last)\b/i,
  /\bgoing forward\b/i,
];

/** Fields worth reconciling across a group. Free text is left alone. */
const RECONCILED_FIELDS = [
  "contactPhone",
  "contactEmail",
  "companyName",
  "contactName",
  "siteLocation",
  "annualConsumption",
  "monthlySpend",
] as const;

/**
 * Where a group disagrees with itself, record both values and say which one is
 * being used and why.
 *
 * Exactly one rule can auto-resolve: a LATER item that explicitly announces
 * itself as a correction wins. The evidence for that is in the text ("Just
 * correcting my number… It is 0411 999 102, not 0411 999 120"), not in a guess
 * about recency. Two values that merely differ, with nobody saying which is
 * right, is an open question for a human — the system holds both and blocks
 * anything that would act on either.
 */
export function resolveConflicts(inputs: EntityInput[]): Conflict[] {
  const conflicts: Conflict[] = [];
  const ordered = [...inputs].sort((a, b) => a.item.seq - b.item.seq);

  for (const field of RECONCILED_FIELDS) {
    const seen = ordered
      .map((i) => {
        const f = i.extraction[field];
        return f
          ? { value: f.value, fromItem: i.item.id, seq: i.item.seq, span: f.sourceSpan, item: i.item }
          : null;
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);

    const canonical = (s: string) =>
      field === "contactPhone"
        ? (normalisePhone(s) ?? s)
        : field === "contactEmail"
          ? (normaliseEmail(s) ?? s)
          : normaliseCompany(s) || s.toLowerCase().trim();

    const distinct = new Set(seen.map((s) => canonical(s.value)));
    if (distinct.size <= 1) continue;

    const last = seen[seen.length - 1]!;
    const isCorrection = CORRECTION_MARKERS.some((re) => re.test(last.item.body));

    conflicts.push({
      field,
      values: seen.map(({ value, fromItem, seq, span }) => ({ value, fromItem, seq, span })),
      resolvedTo: isCorrection ? last.value : null,
      basis: isCorrection
        ? `${last.fromItem} explicitly states a correction and is the latest item in the group; its value supersedes the earlier one, which is retained above.`
        : `${distinct.size} different values with no statement of which is right. Not auto-resolved: a human must choose before this field is used.`,
      autoResolved: isCorrection,
    });
  }

  return conflicts;
}
