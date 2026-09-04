import { z } from "zod";
import { INTENTS } from "./taxonomy.js";

/** ------------------------------------------------------------------
 *  Ingestion
 *
 *  Four supplied sources, one normalised shape. Adapters are plain
 *  deterministic code; no model is involved in getting this far.
 *  ------------------------------------------------------------------ */

export const SourceKindSchema = z.enum(["email", "document", "crm_row", "staff_directory"]);
export type SourceKind = z.infer<typeof SourceKindSchema>;

/**
 * A document that arrived attached to an item.
 *
 * Documents are held SEPARATELY from the email body rather than concatenated
 * into it, for one reason that matters later: when the email and its attachment
 * disagree, the system has to be able to say which of the two it read a value
 * from. Flattening them into one blob throws that away.
 */
export const AttachmentSchema = z.object({
  filename: z.string().min(1),
  text: z.string(),
  /** False when an email references a file the pack does not contain. */
  resolved: z.boolean(),
});
export type Attachment = z.infer<typeof AttachmentSchema>;

export const WorkItemSchema = z.object({
  /** Stable id from the pack (E001…E012). The idempotency key for the pipeline. */
  id: z.string().min(1),
  /** Position in the supplied pack. The only ordering signal the data actually gives. */
  seq: z.number().int().positive(),
  source: SourceKindSchema,
  fromName: z.string().nullable(),
  fromEmail: z.string().nullable(),
  subject: z.string().nullable(),
  body: z.string(),
  attachments: z.array(AttachmentSchema).default([]),
});
export type WorkItem = z.infer<typeof WorkItemSchema>;

/** A row of the supplied CRM export, after parsing. */
export interface CrmRow {
  id: string;
  company: string;
  contact: string;
  email: string;
  phone: string;
  location: string;
  stage: string;
  interest: string;
  status: string;
}

/** ------------------------------------------------------------------
 *  Classification — model output, parsed hostilely
 *  ------------------------------------------------------------------ */

export const ClassificationSchema = z.object({
  intent: z.enum(INTENTS),
  /** The model's own confidence. A weak signal, never treated as truth. */
  confidence: z.number().min(0).max(1),
  /** One sentence for the human reviewer. Never used for routing. */
  rationale: z.string().max(400),
  /** Verbatim quote that drove the call. Verified downstream like any other span. */
  evidence: z.string().max(400),
});
export type Classification = z.infer<typeof ClassificationSchema>;

/** ------------------------------------------------------------------
 *  Extraction
 *  ------------------------------------------------------------------ */

/**
 * Every extracted value carries the span of source text it was read from, and
 * the name of the source it came from. A field whose span cannot be found
 * verbatim in that source is dropped before it can reach a decision.
 *
 * `origin` is new for this dataset and does real work: E001's consumption
 * figure ("about 2.1 GWh per year", from the email) and the attached bill's
 * figure (68,420 kWh for one site in one month) are both true and are not the
 * same claim. Recording which document a number came from is what lets the
 * system present them side by side instead of silently preferring one.
 */
export const GroundedFieldSchema = z.object({
  value: z.string().min(1),
  sourceSpan: z.string().min(1),
  /** "body" for the message itself, or the attachment filename. */
  origin: z.string().min(1).default("body"),
  /**
   * Set by the model where it is genuinely unsure of its own reading, e.g. an
   * imprecise figure like "around two gigawatt hours". Carried through to the
   * UI so a human sees the hedge instead of a clean-looking number.
   */
  approximate: z.boolean().default(false),
});
export type GroundedField = z.infer<typeof GroundedFieldSchema>;

const g = GroundedFieldSchema.nullable().default(null);

export const ExtractionSchema = z.object({
  // --- who ---
  contactName: g,
  contactEmail: g,
  contactPhone: g,
  companyName: g,
  siteLocation: g,
  siteCount: g,

  // --- energy demand ---
  annualConsumption: g,
  monthlySpend: g,
  peakDemand: g,
  fittingCount: g,
  /** Free text: what they are asking about (solar, battery, LED, efficiency). */
  technologies: g,
  /** "leased", "owned", or whatever the source actually says. Drives qualification. */
  tenure: g,

  // --- money in dispute ---
  invoiceRef: g,
  poRef: g,
  invoiceAmount: g,
  poAmount: g,
  disputedAmount: g,

  // --- everything else ---
  deadline: g,
  technicalSubject: g,
  systemName: g,
  errorSummary: g,
  roleApplied: g,
});
export type Extraction = z.infer<typeof ExtractionSchema>;
export type ExtractionField = keyof Extraction;

/** ------------------------------------------------------------------
 *  Cross-document reconciliation
 *  ------------------------------------------------------------------ */

/**
 * Result of checking a claim made in a message against the numbers in the
 * document attached to it. Deterministic arithmetic, not a model call.
 */
export const ReconciliationSchema = z.object({
  kind: z.enum(["invoice_vs_po", "consumption_scope"]),
  /** The numbers the check ran on, so a human can redo the arithmetic by eye. */
  inputs: z.record(z.string()),
  /**
   * agrees            — the message's claim matches the attached document
   * contradicts       — both numbers present and they disagree
   * insufficient_data — the document did not supply what was needed to check
   */
  verdict: z.enum(["agrees", "contradicts", "insufficient_data"]),
  note: z.string(),
});
export type Reconciliation = z.infer<typeof ReconciliationSchema>;

/** ------------------------------------------------------------------
 *  Identity, duplicates and conflicts
 *  ------------------------------------------------------------------ */

export const CrmMatchSchema = z.object({
  crmId: z.string(),
  company: z.string(),
  /** 0–1. Above `autoLinkFloor` the system links; below, it proposes. */
  score: z.number().min(0).max(1),
  /** Named signals, so a human can see WHY it matched, not just how hard. */
  signals: z.array(z.string()),
});
export type CrmMatch = z.infer<typeof CrmMatchSchema>;

/**
 * A field where two sources disagree.
 *
 * The system never silently picks a winner. It records both values, states
 * which it is provisionally using and why, and marks whether the resolution is
 * safe enough to act on. E009/E010 (a phone number corrected by its owner in a
 * later message) resolves cleanly; a mismatch with no corrective language does
 * not, and goes to a person.
 */
export const ConflictSchema = z.object({
  field: z.string(),
  values: z.array(
    z.object({ value: z.string(), fromItem: z.string(), seq: z.number(), span: z.string() }),
  ),
  resolvedTo: z.string().nullable(),
  /** Named rule that resolved it, or why it could not be resolved. */
  basis: z.string(),
  /** False means: do not act on this field until a human rules. */
  autoResolved: z.boolean(),
});
export type Conflict = z.infer<typeof ConflictSchema>;

/** A set of items and CRM rows the system believes describe one real organisation. */
export const EntitySchema = z.object({
  entityId: z.string(),
  displayName: z.string(),
  itemIds: z.array(z.string()),
  crmIds: z.array(z.string()),
  /** Duplicate CRM rows found INSIDE the export, independent of any email. */
  crmInternalDuplicates: z.array(z.array(z.string())),
  conflicts: z.array(ConflictSchema),
  signals: z.array(z.string()),
});
export type Entity = z.infer<typeof EntitySchema>;

/** ------------------------------------------------------------------
 *  Decision
 *  ------------------------------------------------------------------ */

export const ActionSchema = z.enum([
  /** Enough to act: file the record, notify the owner, draft the reply. */
  "file_and_notify",
  /** Real, but something required is missing: draft a question asking for it. */
  "request_missing_info",
  /** A person must decide before anything else happens. */
  "escalate_to_human",
  /** Log it, act internally, but do not reply to the sender. */
  "log_no_reply",
  /** Spam. No record, no reply, retained for appeal. */
  "quarantine",
]);
export type Action = z.infer<typeof ActionSchema>;

export const DecisionSchema = z.object({
  action: ActionSchema,
  intent: z.enum(INTENTS),
  destination: z.string(),
  owner: z.string(),
  ownerName: z.string(),
  consult: z.array(z.string()),
  /** The directory line that justifies this owner. Shown to the human. */
  justification: z.string(),
  slaHours: z.number(),
  missingFields: z.array(z.string()),
  /** Every deterministic rule that fired, by name. The decision's whole argument. */
  reasons: z.array(z.string()),
  /** Things a human should know that are not blocking. */
  warnings: z.array(z.string()),
  /** Whether a reply should exist at all — policy, not a model's discretion. */
  drafting: z.enum(["draft_reply", "draft_question", "no_reply"]),
  /**
   * True for every outbound message this system produces, without exception.
   * A literal, not a boolean: turning it off is a type error, not a config change.
   */
  requiresHumanApproval: z.literal(true),
});
export type Decision = z.infer<typeof DecisionSchema>;
