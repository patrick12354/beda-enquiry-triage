import { z } from "zod";
import { INTENTS } from "./taxonomy.js";

/** ------------------------------------------------------------------
 *  Ingestion
 *  ------------------------------------------------------------------ */

export const ChannelSchema = z.enum([
  "wix_form", // the Register form on wearebeda.com (Wix Forms)
  "email", // hello@ / careers@ mailbox
  "whatsapp", // WhatsApp Business Cloud API
  "instagram_dm", // Meta Graph API
  "linkedin", // manual paste by a BEDA rep
]);
export type Channel = z.infer<typeof ChannelSchema>;

/**
 * The normalised shape every channel adapter must produce. Adapters are plain
 * deterministic code -- no model is involved in getting here.
 */
export const RawEnquirySchema = z.object({
  /** Provider-side id. The idempotency key for the whole pipeline. */
  externalId: z.string().min(1),
  channel: ChannelSchema,
  receivedAt: z.string().datetime(),
  fromName: z.string().nullable(),
  fromEmail: z.string().nullable(),
  fromPhone: z.string().nullable(),
  subject: z.string().nullable(),
  /** Free text, already stripped of quoted reply chains and signatures. */
  body: z.string(),
  /** Structured key/values when the channel has them (Wix form fields). */
  formFields: z.record(z.string()).default({}),
  attachments: z
    .array(z.object({ filename: z.string(), mime: z.string(), bytes: z.number() }))
    .default([]),
  /** Filled by the deterministic pre-filter, not by a model. */
  honeypotTripped: z.boolean().default(false),
});
export type RawEnquiry = z.infer<typeof RawEnquirySchema>;

/** ------------------------------------------------------------------
 *  Classification (LLM output -- must survive a hostile parse)
 *  ------------------------------------------------------------------ */

export const ClassificationSchema = z.object({
  intent: z.enum(INTENTS),
  /** Model's own confidence. Treated as a weak signal, never as truth. */
  confidence: z.number().min(0).max(1),
  /** One short sentence, shown to the human reviewer. Not used for routing. */
  rationale: z.string().max(300),
  /** Verbatim quote from the enquiry that drove the call. Verified downstream. */
  evidence: z.string().max(400),
});
export type Classification = z.infer<typeof ClassificationSchema>;

/** ------------------------------------------------------------------
 *  Extraction
 *  ------------------------------------------------------------------ */

/**
 * Every extracted value carries the span of source text it came from. A field
 * whose span cannot be found verbatim in the source is dropped before it ever
 * reaches a decision. This is the main anti-hallucination control and it is
 * enforced by deterministic code, not by asking the model nicely.
 */
export const GroundedFieldSchema = z.object({
  value: z.string().min(1),
  sourceSpan: z.string().min(1),
});
export type GroundedField = z.infer<typeof GroundedFieldSchema>;

const optionalGrounded = GroundedFieldSchema.nullable().default(null);

export const ExtractionSchema = z.object({
  contactName: optionalGrounded,
  email: optionalGrounded,
  phone: optionalGrounded,
  companyName: optionalGrounded,
  companyWebsite: optionalGrounded,
  /** Candidate side: which track they want. */
  track: optionalGrounded,
  currentLocation: optionalGrounded,
  currentRole: optionalGrounded,
  /** Client side: what they want to hire. */
  rolesSought: optionalGrounded,
  headcount: optionalGrounded,
  timeline: optionalGrounded,
  budget: optionalGrounded,
  issueSummary: optionalGrounded,
});
export type Extraction = z.infer<typeof ExtractionSchema>;
export type ExtractionField = keyof Extraction;

/** ------------------------------------------------------------------
 *  Decision
 *  ------------------------------------------------------------------ */

export const ActionSchema = z.enum([
  "file_and_notify", // enough info: write record, ping owner, draft reply for approval
  "request_missing_info", // draft a clarifying question -- still needs approval to send
  "escalate_to_human", // low confidence or high value: a person decides
  "quarantine", // spam: no record, retained for audit and appeal
]);
export type Action = z.infer<typeof ActionSchema>;

export const DecisionSchema = z.object({
  action: ActionSchema,
  intent: z.enum(INTENTS),
  destination: z.string(),
  owner: z.string(),
  slaMinutes: z.number(),
  missingFields: z.array(z.string()),
  /** Which deterministic rule fired. Every decision is explainable by name. */
  reasons: z.array(z.string()),
  /** True for every outbound message this system produces, without exception. */
  requiresHumanApproval: z.literal(true),
});
export type Decision = z.infer<typeof DecisionSchema>;
