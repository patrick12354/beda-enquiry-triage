import {
  DecisionSchema,
  type Classification,
  type Conflict,
  type CrmMatch,
  type CrmRow,
  type Decision,
  type Extraction,
  type Reconciliation,
  type WorkItem,
} from "../domain/schema.js";
import {
  REQUIRED_FIELDS,
  ROUTING,
  SALES_ROUTING,
  staffName,
  type Intent,
  type Owner,
} from "../domain/taxonomy.js";
import { plainValues } from "./grounding.js";
import { parseEnergyKwh, parseMoney } from "./reconcile.js";

/**
 * THE GATE.
 *
 * The model classifies and extracts. This function decides. It is ordinary,
 * testable, deterministic code — no network, no model, no randomness — and it
 * is the only place in the system where an action is chosen.
 *
 * The reason is not purity. A decision made inside a model cannot be unit
 * tested, cannot be diffed in a pull request, and changes silently when the
 * provider ships a new checkpoint. Who owns a lead, what counts as a major
 * opportunity, and when a person must look before anything moves are BEDA's
 * business policy. Business policy belongs in code someone can read, argue
 * with, and change on purpose.
 *
 * So: the LLM is a sensor, not an actuator.
 *
 * Every branch below appends a named reason. The list of reasons IS the
 * decision's argument, and it is what the audit log and the inspector show.
 */

export interface GateInput {
  item: WorkItem;
  classification: Classification;
  extraction: Extraction;
  /** Fields the grounding check threw away: treated as absent AND as a warning. */
  droppedFields: string[];
  /** Deterministic arithmetic against attached documents. */
  reconciliations: Reconciliation[];
  /** Best CRM row, and whether the strong matches disagree about which org this is. */
  crmMatch: CrmMatch | null;
  crmAmbiguous: boolean;
  /** The matched row, used to fill fields the message itself omits. */
  crmRow: CrmRow | null;
  /** Field-level disagreements within this item's entity group. */
  conflicts: Conflict[];
  /** The most recent earlier item belonging to the same entity, with its intent. */
  earlierSibling: { id: string; intent: Intent } | null;
  /** Whether this item announces itself as a correction to an earlier one. */
  isAmendment: boolean;
  /** True when a referenced attachment was not supplied with the pack. */
  hasUnresolvedAttachment: boolean;
  /** True when the body claims an attachment and none arrived at all. */
  claimsMissingAttachment: boolean;
  /** Set when the CRM's own sync is known to be broken. Degrades match trust. */
  crmTrustDegraded: boolean;
}

/**
 * Confidence floors, per intent. Higher where being wrong is expensive.
 *
 * The spam floor is the important one. Being wrong about spam means a real
 * customer is silently binned, and nobody ever finds out. Near-certainty is
 * required; anything less goes to a person rather than to the bin.
 */
const CONFIDENCE_FLOOR: Record<Intent, number> = {
  sales_enquiry: 0.7,
  billing_dispute: 0.75,
  technical_query: 0.7,
  partner_operations: 0.7,
  internal_alert: 0.8,
  job_application: 0.7,
  spam: 0.95,
  unclear: 0,
};

/**
 * Financial variance above which a person, not the system, owns the response.
 * A business number, kept where a business person can find it.
 */
const BILLING_ESCALATION_AUD = 1_000;

/** Fields the CRM is allowed to supply when the message itself omits them. */
const CRM_FILLABLE: Record<string, keyof CrmRow> = {
  companyName: "company",
  contactName: "contact",
  siteLocation: "location",
  contactEmail: "email",
  contactPhone: "phone",
};

export interface QualificationResult {
  band: "major" | "standard" | "marginal" | "unknown";
  basis: string;
  annualKwh: number | null;
  monthlySpend: number | null;
}

/**
 * How big is this, in the only terms the directory cares about?
 *
 * The directory says Matt owns MAJOR commercial opportunities, so "major" has
 * to mean something specific. It means an annual consumption or a monthly spend
 * over a threshold that lives in taxonomy.ts, where a business person can move
 * it without touching this file.
 *
 * "unknown" is a real band and is not the same as "marginal". An enquiry with
 * no stated figures is not small — it is unmeasured, and it gets asked, not
 * demoted.
 */
export function qualify(extraction: Extraction): QualificationResult {
  const v = plainValues(extraction);
  const annualKwh = v.annualConsumption ? parseEnergyKwh(v.annualConsumption) : null;
  const monthlySpend = v.monthlySpend ? parseMoney(v.monthlySpend) : null;
  const tenure = (v.tenure ?? "").toLowerCase();

  if (annualKwh !== null && annualKwh >= SALES_ROUTING.majorAnnualKwh) {
    return {
      band: "major",
      basis: `${annualKwh.toLocaleString("en-AU")} kWh/year is at or above the ${SALES_ROUTING.majorAnnualKwh.toLocaleString("en-AU")} kWh major-opportunity threshold.`,
      annualKwh,
      monthlySpend,
    };
  }
  if (monthlySpend !== null && monthlySpend >= SALES_ROUTING.majorMonthlySpendAud) {
    return {
      band: "major",
      basis: `$${monthlySpend.toLocaleString("en-AU")}/month is at or above the $${SALES_ROUTING.majorMonthlySpendAud.toLocaleString("en-AU")} major-opportunity threshold.`,
      annualKwh,
      monthlySpend,
    };
  }
  if (monthlySpend !== null && monthlySpend < SALES_ROUTING.marginalMonthlySpendAud) {
    const leased = /leas|rent|tenan/.test(tenure);
    return {
      band: "marginal",
      basis:
        `$${monthlySpend.toLocaleString("en-AU")}/month is below the $${SALES_ROUTING.marginalMonthlySpendAud.toLocaleString("en-AU")} threshold at which a standalone commercial job typically stacks up` +
        (leased ? ", and the site is leased, so roof access is not the enquirer's to grant." : "."),
      annualKwh,
      monthlySpend,
    };
  }
  if (annualKwh !== null || monthlySpend !== null) {
    return { band: "standard", basis: "Figures supplied, below the major threshold.", annualKwh, monthlySpend };
  }
  return {
    band: "unknown",
    basis: "No consumption or spend figure was stated. Size is unmeasured, not small.",
    annualKwh,
    monthlySpend,
  };
}

export function decide(input: GateInput): Decision {
  const { classification, extraction, item } = input;
  const reasons: string[] = [];
  const warnings: string[] = [];
  let intent = classification.intent;
  let owner: Owner | null = null;
  let justificationOverride: string | null = null;

  // Facts about the request that a human should see regardless of outcome.
  if (input.hasUnresolvedAttachment) {
    warnings.push("referenced_attachment_not_supplied");
  }
  if (input.claimsMissingAttachment) {
    warnings.push("body_claims_an_attachment_but_none_arrived");
  }
  if (input.crmTrustDegraded) {
    warnings.push("crm_sync_failing_matches_may_be_against_stale_data");
  }
  for (const f of input.droppedFields) warnings.push(`ungrounded_field_dropped:${f}`);

  // --- 0. A correction inherits the thread it corrects ----------------------
  // E010 reads, on its own, as unclassifiable: "Just correcting my number…
  // Please use this email address going forward." There is no enquiry in it,
  // because the enquiry was E009. Classified in isolation the honest answer is
  // "unclear", and acting on that would open a second, empty case for a
  // customer who is already in the pipeline.
  //
  // So an item that announces itself as a correction and belongs to a known
  // thread takes that thread's category. The inheritance is recorded by name;
  // it is never silent, and it requires BOTH the correction language and an
  // established sibling — an unclear item with neither still goes to a person.
  let inheritedIntent = false;
  if (intent === "unclear" && input.isAmendment && input.earlierSibling) {
    intent = input.earlierSibling.intent;
    inheritedIntent = true;
    reasons.push(`intent_inherited_from_thread:${input.earlierSibling.id}:${intent}`);
  }

  // --- 1. "unclear" is terminal --------------------------------------------
  // It has no required fields and a zero confidence floor, so without this it
  // would fall through to the happy path. "I don't know" must always mean "a
  // person looks", never "file it somewhere and hope".
  if (intent === "unclear") {
    reasons.push("intent_unclear_requires_human");
    return finalise("escalate_to_human", "unclear", reasons, warnings, [], owner, justificationOverride);
  }

  // --- 2. Confidence floor --------------------------------------------------
  // An inherited intent is exempt, and the reason is not a loophole: the
  // model's confidence score was its confidence in "unclear", which it was
  // right about. Testing that number against the floor for a category the model
  // never chose would send every correction to a human on the strength of a
  // score about a different question.
  if (!inheritedIntent && classification.confidence < CONFIDENCE_FLOOR[intent]) {
    reasons.push(
      `below_confidence_floor:${intent}:${classification.confidence.toFixed(2)}<${CONFIDENCE_FLOOR[intent]}`,
    );
    return finalise(
      "escalate_to_human",
      intent,
      reasons,
      warnings,
      missingFor(intent, extraction, input.crmRow, reasons),
      owner,
      justificationOverride,
    );
  }

  // --- 3. Spam --------------------------------------------------------------
  if (intent === "spam") {
    reasons.push("classified_spam_above_floor");
    // No record, no reply. Retained in quarantine so the call is reversible.
    return finalise("quarantine", intent, reasons, warnings, [], owner, justificationOverride);
  }

  // --- 4. Widespread grounding failure --------------------------------------
  // One dropped field is noise. Two or more means the model was improvising
  // about this item, and nothing else it said should be trusted enough to file.
  if (input.droppedFields.length >= 2) {
    reasons.push(`ungrounded_fields:${input.droppedFields.join(",")}`);
    return finalise(
      "escalate_to_human",
      intent,
      reasons,
      warnings,
      missingFor(intent, extraction, input.crmRow, reasons),
      owner,
      justificationOverride,
    );
  }

  // --- 5. Ambiguous identity ------------------------------------------------
  // Strong matches pointing at DIFFERENT organisations. Filing against the
  // wrong company corrupts two histories and un-merging is manual.
  if (input.crmAmbiguous) {
    reasons.push("ambiguous_crm_match_between_distinct_organisations");
    return finalise(
      "escalate_to_human",
      intent,
      reasons,
      warnings,
      missingFor(intent, extraction, input.crmRow, reasons),
      owner,
      justificationOverride,
    );
  }
  if (input.crmMatch) {
    reasons.push(`crm_linked:${input.crmMatch.crmId}:${input.crmMatch.signals.join("+")}`);
  } else {
    reasons.push("no_crm_match_new_organisation");
  }

  // --- 6. Amendments and duplicates ----------------------------------------
  // These are different things and the difference matters. An amendment carries
  // new information and must be absorbed; a duplicate carries none and must not
  // generate a second reply. Neither should produce a second opportunity.
  const unresolved = input.conflicts.filter((c) => !c.autoResolved);
  const resolved = input.conflicts.filter((c) => c.autoResolved);
  for (const c of resolved) reasons.push(`conflict_resolved:${c.field}->${c.resolvedTo}`);

  const sameThread = input.earlierSibling?.intent === intent ? input.earlierSibling : null;
  if (sameThread && input.isAmendment) {
    reasons.push(`amendment_to:${sameThread.id}`);
    reasons.push("no_second_reply_amendment_absorbed_into_existing_thread");
    return finalise("log_no_reply", intent, reasons, warnings, [], owner, justificationOverride);
  }
  if (sameThread) {
    reasons.push(`duplicate_of:${sameThread.id}`);
    reasons.push("no_second_opportunity_no_second_reply");
    return finalise("log_no_reply", intent, reasons, warnings, [], owner, justificationOverride);
  }

  // --- 7. Unresolved conflicts block action --------------------------------
  // Two values for a field, nobody saying which is right. Acting on either is a
  // coin flip with a customer's contact details.
  if (unresolved.length > 0) {
    reasons.push(`unresolved_conflicts:${unresolved.map((c) => c.field).join(",")}`);
    return finalise(
      "escalate_to_human",
      intent,
      reasons,
      warnings,
      missingFor(intent, extraction, input.crmRow, reasons),
      owner,
      justificationOverride,
    );
  }

  // --- 8. Intent-specific policy -------------------------------------------

  if (intent === "internal_alert") {
    // A machine wrote this. It needs a ticket, not a conversation.
    reasons.push("machine_originated_no_reply_by_policy");
    const v = plainValues(extraction);
    if (/\d/.test(v.errorSummary ?? "") || /unsynchronis|unsynchroniz/i.test(item.body)) {
      reasons.push("alert_affects_the_crm_this_pipeline_reads_from");
    }
    return finalise("log_no_reply", intent, reasons, warnings, [], owner, justificationOverride);
  }

  if (intent === "technical_query") {
    // The directory has no engineer. Rather than assign an electrical
    // engineering question to whoever is closest alphabetically, the system
    // names the gap and asks the founder to nominate someone qualified.
    reasons.push("no_engineering_owner_in_staff_directory");
    reasons.push("system_will_not_answer_a_safety_adjacent_technical_question");
    return finalise(
      "escalate_to_human",
      intent,
      reasons,
      warnings,
      missingFor(intent, extraction, input.crmRow, reasons),
      owner,
      justificationOverride,
    );
  }

  if (intent === "billing_dispute") {
    const rec = input.reconciliations.find((r) => r.kind === "invoice_vs_po");
    if (rec?.verdict === "contradicts") {
      reasons.push("document_arithmetic_contradicts_the_claim");
      return finalise("escalate_to_human", intent, reasons, warnings, [], owner, justificationOverride);
    }
    if (rec?.verdict === "agrees") {
      reasons.push("claim_independently_verified_against_attached_document");
    } else {
      reasons.push("claim_not_verifiable_from_supplied_documents");
      warnings.push("variance_unverified");
    }
    const amount = parseMoney(plainValues(extraction).disputedAmount ?? "");
    if (amount !== null && amount >= BILLING_ESCALATION_AUD) {
      reasons.push(`variance_above_escalation_threshold:$${amount.toLocaleString("en-AU")}`);
      return finalise("escalate_to_human", intent, reasons, warnings, [], owner, justificationOverride);
    }
  }

  let qualification: QualificationResult | null = null;
  if (intent === "sales_enquiry") {
    qualification = qualify(extraction);
    reasons.push(`qualification:${qualification.band}`);
    if (qualification.band === "major") {
      owner = SALES_ROUTING.promotedOwner;
      justificationOverride = SALES_ROUTING.promotedJustification;
      reasons.push("promoted_to_founder_major_opportunity");
    }
    if (qualification.band === "marginal") {
      warnings.push("qualification_marginal_review_before_investing_time");
    }
    const tenure = (plainValues(extraction).tenure ?? "").toLowerCase();
    if (/leas|rent|tenan/.test(tenure)) {
      warnings.push("premises_leased_roof_rights_not_the_enquirers_to_grant");
    }
  }

  // --- 9. Completeness ------------------------------------------------------
  const missing = missingFor(intent, extraction, input.crmRow, reasons);
  if (missing.length > 0) {
    const contactable = Boolean(plainValues(extraction).contactEmail ?? item.fromEmail);
    if (!contactable) {
      reasons.push("incomplete_and_uncontactable");
      return finalise("escalate_to_human", intent, reasons, warnings, missing, owner, justificationOverride);
    }
    reasons.push(`missing_required:${missing.join(",")}`);
    return finalise("request_missing_info", intent, reasons, warnings, missing, owner, justificationOverride);
  }

  reasons.push("complete_and_confident");
  return finalise("file_and_notify", intent, reasons, warnings, [], owner, justificationOverride);
}

/**
 * Which required fields are still unknown.
 *
 * A confidently matched CRM row is allowed to supply what the message omits.
 * That is the difference between E008 — Daniel Wu, whose company is a known
 * partner, so "which company?" is a question BEDA already has the answer to —
 * and E009, whose organisation has never been seen before and genuinely must be
 * asked. Every CRM-supplied field is recorded by name so the provenance is
 * visible rather than implied.
 */
function missingFor(
  intent: Intent,
  extraction: Extraction,
  crmRow: CrmRow | null,
  reasons: string[],
): string[] {
  const present = plainValues(extraction);
  const out: string[] = [];

  for (const field of REQUIRED_FIELDS[intent]) {
    if (satisfied(field, present)) continue;

    const crmField = CRM_FILLABLE[field];
    const fromCrm = crmRow && crmField ? crmRow[crmField]?.trim() : "";
    if (fromCrm) {
      const note = `field_from_crm:${field}=${fromCrm}(${crmRow!.id})`;
      if (!reasons.includes(note)) reasons.push(note);
      continue;
    }
    out.push(field);
  }
  return out;
}

/**
 * `consumptionOrSpend` is a requirement satisfied by either of two real fields.
 * Encoding that here keeps the requirement list readable for a business reader
 * without pretending there is a field by that name.
 */
function satisfied(field: string, present: Partial<Record<string, string>>): boolean {
  if (field === "consumptionOrSpend") {
    return Boolean(present.annualConsumption ?? present.monthlySpend ?? present.peakDemand);
  }
  return Boolean(present[field]);
}

function finalise(
  action: Decision["action"],
  intent: Intent,
  reasons: string[],
  warnings: string[],
  missingFields: string[],
  ownerOverride: Owner | null,
  justificationOverride: string | null,
): Decision {
  const route = ROUTING[intent];
  const owner = ownerOverride ?? route.owner;

  // Whether a reply should exist at all is policy from the taxonomy, combined
  // with the action. It is never the drafting model's decision.
  const drafting: Decision["drafting"] =
    action === "quarantine" || route.responsePolicy === "never_reply"
      ? "no_reply"
      : action === "log_no_reply"
        ? "no_reply"
        : action === "request_missing_info"
          ? "draft_question"
          : "draft_reply";

  return DecisionSchema.parse({
    action,
    intent,
    destination: route.destination,
    owner,
    ownerName: staffName(owner),
    consult: route.consult,
    justification: justificationOverride ?? route.justification,
    slaHours: route.slaHours,
    missingFields,
    reasons,
    warnings,
    drafting,
    // Not a variable. There is no code path in this system that sends an
    // outbound message without a named human approving that specific draft.
    requiresHumanApproval: true,
  });
}
