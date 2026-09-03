/**
 * The intent taxonomy is the single most important design decision in this system.
 *
 * BEDA is a two-sided business: it recruits sales & marketing talent in Bali and
 * places them with Australian companies. So an "enquiry" is not one thing. The
 * expensive mistake is not misjudging a lead's value -- it is putting a CANDIDATE
 * into the CLIENT sales pipeline, or vice versa. Those are different records, in
 * different systems, with different owners, different SLAs and different privacy
 * obligations.
 *
 * The taxonomy is therefore split by SIDE first, and only then by intent.
 */

export const INTENTS = [
  // --- Demand side: Australian companies who want to hire through BEDA ---
  "client_new_business", // wants to hire / wants a proposal / wants to talk
  "client_existing", // an existing client: expansion, replacement, account matter

  // --- Supply side: people who want to work with BEDA in Bali ---
  "candidate_application", // the Wix form, or an email with a CV
  "candidate_question", // pre-application question: visa, pay, relocation

  // --- Neither side is buying or applying ---
  "support", // a placed staff member or client with an operational issue
  "partnership", // press, referral partners, coworking/venue, community
  "spam", // SEO/agency cold outreach, link farms, automated junk
  "unclear", // real human, not enough signal to route safely
] as const;

export type Intent = (typeof INTENTS)[number];

/** Which system of record owns a given intent. */
export type Destination =
  | "crm_deal" // HubSpot deal + company + contact
  | "ats_candidate" // applicant tracking record
  | "helpdesk_ticket"
  | "crm_contact_only" // logged as a contact, no pipeline
  | "no_record"; // spam: quarantined, never written to a system of record

export interface RouteRule {
  destination: Destination;
  /** Slack channel / rota that owns the first human touch. */
  owner: string;
  /** Time to first human response, in minutes. Drives escalation timers. */
  slaMinutes: number;
  /**
   * May the system create/update the record without a human first?
   * Note this is only ever about INTERNAL record-keeping. Nothing outbound is
   * ever auto-sent -- see docs/DESIGN.md section 8.
   */
  autoFileRecord: boolean;
}

export const ROUTING: Record<Intent, RouteRule> = {
  client_new_business: {
    destination: "crm_deal",
    owner: "#beda-newbiz",
    slaMinutes: 60,
    autoFileRecord: true,
  },
  client_existing: {
    destination: "crm_deal",
    owner: "#beda-accounts",
    slaMinutes: 120,
    autoFileRecord: true,
  },
  candidate_application: {
    destination: "ats_candidate",
    owner: "#beda-talent",
    slaMinutes: 1440,
    autoFileRecord: true,
  },
  candidate_question: {
    destination: "crm_contact_only",
    owner: "#beda-talent",
    slaMinutes: 1440,
    autoFileRecord: true,
  },
  support: {
    destination: "helpdesk_ticket",
    owner: "#beda-ops",
    slaMinutes: 240,
    autoFileRecord: true,
  },
  partnership: {
    destination: "crm_contact_only",
    owner: "#beda-newbiz",
    slaMinutes: 2880,
    autoFileRecord: true,
  },
  // Spam is never written to a system of record -- it would poison contact
  // counts, deal reporting and any future training data. It is quarantined in
  // our own store so the decision stays auditable and reversible.
  spam: {
    destination: "no_record",
    owner: "#beda-intake-review",
    slaMinutes: 10080,
    autoFileRecord: false,
  },
  // "unclear" deliberately files nothing. Guessing a destination here is how
  // candidates end up in the sales pipeline.
  unclear: {
    destination: "no_record",
    owner: "#beda-intake-review",
    slaMinutes: 480,
    autoFileRecord: false,
  },
};

/**
 * Fields required before an intent can be filed and acted on. Anything missing
 * is what the clarifying question is allowed to ask for -- nothing else.
 */
export const REQUIRED_FIELDS: Record<Intent, readonly string[]> = {
  client_new_business: ["companyName", "contactName", "email", "rolesSought"],
  client_existing: ["companyName", "email"],
  candidate_application: ["contactName", "email", "track"],
  candidate_question: ["contactName", "email"],
  support: ["contactName", "email", "issueSummary"],
  partnership: ["contactName", "email"],
  spam: [],
  unclear: [],
} as const;
