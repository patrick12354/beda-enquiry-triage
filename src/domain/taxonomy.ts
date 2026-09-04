/**
 * The taxonomy is the most consequential design decision in the system, so it
 * is one file, in plain code, that a non-engineer at BEDA can read and argue
 * with.
 *
 * Two separations are deliberate and worth stating up front, because most of
 * the interesting behaviour falls out of them.
 *
 * 1. CATEGORY is separate from VALUE.
 *    "This is a sales enquiry" and "this sales enquiry is worth the founder's
 *    time" are different questions with different evidence. A cafe on a leased
 *    roof spending $900/month and a logistics group with 2.1 GWh across three
 *    sites are the SAME category and wildly different opportunities. Collapsing
 *    them into two intents would hide the judgement inside a label the model
 *    produces. Instead the model says what an item IS; deterministic code in
 *    the gate decides what it is WORTH, and routes accordingly.
 *
 * 2. OWNERSHIP comes from the supplied staff directory, not from invention.
 *    Every route below quotes the directory line that justifies it. Where the
 *    directory does NOT cover something -- there is no engineer at BEDA, and
 *    E006 asks for one by name -- the system says so instead of inventing a
 *    plausible owner. See `technical_query`.
 */

export const INTENTS = [
  /** Someone outside BEDA wants to buy energy work: solar, battery, LED, efficiency. */
  "sales_enquiry",
  /** An existing customer disputes or queries money already invoiced. */
  "billing_dispute",
  /** An engineering question that needs a qualified engineer to answer. */
  "technical_query",
  /** A delivery partner coordinating crews, sites, scheduling or logistics. */
  "partner_operations",
  /** A machine talking to BEDA: monitoring, sync failures, job alerts. */
  "internal_alert",
  /** A person asking to work at BEDA. */
  "job_application",
  /** Unsolicited commercial junk. Never filed, never answered, always retained. */
  "spam",
  /** Real, but the system cannot tell what it is. A terminal state, not a guess. */
  "unclear",
] as const;

export type Intent = (typeof INTENTS)[number];

/** The four people in the supplied directory, plus the two non-person sinks. */
export type Owner = "matt" | "ties" | "zidane" | "ali" | "unassigned" | "quarantine";

export interface StaffMember {
  id: Owner;
  name: string;
  role: string;
  owns: string;
}

/** Where an item is filed. Keeping this explicit stops "we replied but nobody logged it". */
export type Destination =
  | "crm_opportunity" // a commercial record with a value attached
  | "crm_contact_only" // logged against a contact, no pipeline value
  | "finance_case" // an invoice/PO reconciliation case
  | "ops_task" // scheduling, logistics, admin
  | "engineering_queue" // needs a qualified engineer
  | "internal_ticket" // a systems/infrastructure fault
  | "recruitment_inbox"
  | "quarantine"; // spam: retained, never written to a system of record

/**
 * Whether a reply to the sender is appropriate at all.
 *
 * This is policy, not a model call. Two items in the pack must never receive a
 * reply and the reason differs for each: E004 is spam, and replying confirms a
 * live mailbox to a list vendor; E011 is a monitoring robot, and replying to it
 * is noise that trains the team to ignore the channel. Both are encoded here
 * rather than left to the drafting model's discretion.
 */
export type ResponsePolicy =
  | "reply_expected" // a person wrote in and is waiting
  | "reply_if_contactable" // reply only when we have a usable address
  | "never_reply"; // answering is wrong, not merely unnecessary

export interface RouteRule {
  destination: Destination;
  owner: Owner;
  /** Others who need to see it. Ownership is singular; awareness is not. */
  consult: Owner[];
  /** Why this owner, quoted from the directory. Surfaced in the UI and the audit log. */
  justification: string;
  responsePolicy: ResponsePolicy;
  /** Time to first human response, in hours. Drives the overdue flag in the UI. */
  slaHours: number;
  /** May the system write an internal record before a human has looked? */
  autoFileRecord: boolean;
}

export const STAFF: Record<Exclude<Owner, "unassigned" | "quarantine">, StaffMember> = {
  matt: {
    id: "matt",
    name: "Matt Cooper",
    role: "Founder",
    owns: "Major commercial opportunities and strategic partnerships.",
  },
  ties: {
    id: "ties",
    name: "Ties Rahardjo",
    role: "Executive Operations Coordinator",
    owns: "Scheduling, administration, logistics and general operational enquiries.",
  },
  zidane: {
    id: "zidane",
    name: "Zidane Mouldino",
    role: "Marketing and Growth Coordinator",
    owns: "Marketing, website and inbound growth enquiries.",
  },
  ali: {
    id: "ali",
    name: "Ali Pratama",
    role: "Senior Business Analyst",
    owns: "CRM, systems, data, workflows and infrastructure issues.",
  },
};

export function staffName(o: Owner): string {
  if (o === "unassigned") return "Unassigned — no directory owner";
  if (o === "quarantine") return "Quarantine — no owner by design";
  return STAFF[o].name;
}

/**
 * Base routing. `sales_enquiry` is the interesting one: the directory splits
 * commercial work between two people on VALUE, not on topic, so the base rule
 * here is the growth coordinator and the gate promotes to the founder when the
 * opportunity clears a threshold. See SALES_ROUTING below.
 */
export const ROUTING: Record<Intent, RouteRule> = {
  sales_enquiry: {
    destination: "crm_opportunity",
    owner: "zidane",
    consult: [],
    justification:
      'Zidane Mouldino owns "marketing, website and inbound growth enquiries". Inbound demand lands with him by default; the gate promotes major opportunities to Matt.',
    responsePolicy: "reply_expected",
    slaHours: 24,
    autoFileRecord: true,
  },

  billing_dispute: {
    destination: "finance_case",
    owner: "ties",
    consult: ["matt"],
    justification:
      'Ties Rahardjo owns "administration". An invoice-to-PO variance is an administrative reconciliation; Matt is consulted because the commercial relationship is his.',
    responsePolicy: "reply_expected",
    slaHours: 8,
    autoFileRecord: true,
  },

  /**
   * The directory contains no engineer. E006 asks, in terms, for "your
   * engineer" to confirm THD limits at the point of common coupling.
   *
   * Inventing an owner here would be the single most tempting wrong answer in
   * the pack: any of the four names could be made to sound plausible, and the
   * system would then have quietly assigned a safety-adjacent electrical
   * engineering question to someone unqualified to answer it. So the owner is
   * `unassigned`, the gap is named in the reason codes, and the item is routed
   * to Matt only for the decision "who should answer this", not for the answer.
   */
  technical_query: {
    destination: "engineering_queue",
    owner: "unassigned",
    consult: ["matt"],
    justification:
      "No engineering role exists in the supplied staff directory. The system will not assign an electrical engineering question to a non-engineer; Matt is asked to nominate a qualified responder.",
    responsePolicy: "reply_if_contactable",
    slaHours: 24,
    autoFileRecord: true,
  },

  partner_operations: {
    destination: "ops_task",
    owner: "ties",
    consult: ["matt"],
    justification:
      'Ties Rahardjo owns "scheduling, administration, logistics". Crew holds and install dates are his. Matt is consulted because whether a project proceeds is a commercial fact Ties may not hold.',
    responsePolicy: "reply_expected",
    slaHours: 8,
    autoFileRecord: true,
  },

  /**
   * A robot wrote this. Replying is not "unnecessary" -- it is wrong, and it is
   * how alert channels become noise people stop reading.
   */
  internal_alert: {
    destination: "internal_ticket",
    owner: "ali",
    consult: [],
    justification:
      'Ali Pratama owns "CRM, systems, data, workflows and infrastructure issues". A failed HubSpot sync is squarely his.',
    responsePolicy: "never_reply",
    slaHours: 4,
    autoFileRecord: true,
  },

  job_application: {
    destination: "recruitment_inbox",
    owner: "ties",
    consult: ["zidane"],
    justification:
      'Ties Rahardjo owns "administration"; hiring admin is his. Zidane is consulted because the role applied for sits in his function.',
    responsePolicy: "reply_expected",
    slaHours: 72,
    autoFileRecord: false,
  },

  /**
   * Spam is never written to a system of record. It would poison contact
   * counts, pipeline reporting and any future training set. It is retained in
   * quarantine so the decision stays auditable and reversible -- a wrongly
   * binned customer must be recoverable.
   */
  spam: {
    destination: "quarantine",
    owner: "quarantine",
    consult: [],
    justification: "Unsolicited commercial outreach. No owner, no record, retained for appeal.",
    responsePolicy: "never_reply",
    slaHours: 168,
    autoFileRecord: false,
  },

  /**
   * "unclear" files nothing and answers nothing. Guessing a destination is how
   * a real customer ends up in the recruitment inbox.
   */
  unclear: {
    destination: "crm_contact_only",
    owner: "ties",
    consult: [],
    justification:
      'Ties Rahardjo owns "general operational enquiries", which is the correct home for anything the system could not confidently categorise.',
    responsePolicy: "reply_if_contactable",
    slaHours: 12,
    autoFileRecord: false,
  },
};

/**
 * Value-based promotion for sales enquiries.
 *
 * The directory says Matt owns MAJOR commercial opportunities. "Major" is a
 * business threshold, so it lives here as a number a business person can move,
 * not as a judgement inside a prompt.
 *
 * The thresholds are deliberately coarse. The system is not trying to price the
 * job; it is trying to answer "does the founder need to see this today".
 */
export const SALES_ROUTING = {
  /** Annual consumption at or above this is a major opportunity. */
  majorAnnualKwh: 500_000,
  /** Monthly spend at or above this is a major opportunity. */
  majorMonthlySpendAud: 20_000,
  /** Below this monthly spend, a standalone commercial solar job rarely stacks up. */
  marginalMonthlySpendAud: 2_000,
  promotedOwner: "matt" as Owner,
  promotedJustification:
    'Matt Cooper owns "major commercial opportunities". This enquiry clears the major-opportunity threshold.',
} as const;

/**
 * What must be known before an item can be acted on rather than asked about.
 *
 * This list is also the ONLY thing a clarifying question is allowed to ask for.
 * Bounding it here stops the drafting model from turning a one-line reply into
 * a nine-question intake form, which is the fastest way to lose a warm lead.
 */
export const REQUIRED_FIELDS: Record<Intent, readonly string[]> = {
  sales_enquiry: ["contactName", "companyName", "siteLocation", "consumptionOrSpend"],
  billing_dispute: ["companyName", "invoiceRef", "disputedAmount"],
  technical_query: ["companyName", "technicalSubject"],
  partner_operations: ["companyName", "deadline"],
  internal_alert: ["systemName", "errorSummary"],
  job_application: ["contactName", "roleApplied"],
  spam: [],
  unclear: [],
} as const;

/** Human-readable labels for the UI, kept next to the enum they describe. */
export const INTENT_LABELS: Record<Intent, string> = {
  sales_enquiry: "Sales enquiry",
  billing_dispute: "Billing dispute",
  technical_query: "Technical query",
  partner_operations: "Partner operations",
  internal_alert: "Internal alert",
  job_application: "Job application",
  spam: "Spam",
  unclear: "Unclear",
};
