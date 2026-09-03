import {
  DecisionSchema,
  type Classification,
  type Decision,
  type Extraction,
  type RawEnquiry,
} from "../domain/schema.js";
import { REQUIRED_FIELDS, ROUTING, type Intent } from "../domain/taxonomy.js";
import { plainValues } from "./grounding.js";

/**
 * THE GATE.
 *
 * This is the part I would defend hardest in review. The model classifies and
 * extracts; this function decides. It is ordinary, testable, deterministic code
 * with no network calls and no model, and it is the only place an `action` is
 * ever produced.
 *
 * The reason is simple: a decision made by a model cannot be unit-tested,
 * cannot be diffed in a pull request, and changes silently when a provider
 * ships a new checkpoint. BEDA's routing rules are business policy. Business
 * policy belongs in code that a person can read, argue with, and change on
 * purpose.
 *
 * So: the LLM is a sensor, not an actuator.
 */

export interface GateInput {
  enquiry: RawEnquiry;
  classification: Classification;
  extraction: Extraction;
  /** Fields the grounding check threw away. Treated as absent AND as a warning. */
  droppedFields: string[];
  /** From deterministic identity resolution, not from the model. */
  duplicateOf: string | null;
  ambiguousCompanyMatches: number;
}

/** Confidence floors, per intent. Higher where being wrong is expensive. */
const CONFIDENCE_FLOOR: Record<Intent, number> = {
  // A real client enquiry misrouted to the talent inbox is lost revenue, and a
  // candidate misrouted into the sales pipeline is a privacy and dignity
  // problem. Both sides of the marketplace get the strictest floor.
  client_new_business: 0.8,
  client_existing: 0.75,
  candidate_application: 0.8,
  candidate_question: 0.7,
  support: 0.7,
  partnership: 0.6,
  // Being wrong about spam means a real person is ignored. Require near
  // certainty; anything less goes to a human, not to the bin.
  spam: 0.95,
  unclear: 0.0,
};

export function decide(input: GateInput): Decision {
  const { classification, extraction, enquiry } = input;
  const reasons: string[] = [];
  let intent = classification.intent;

  // --- 1. Deterministic overrides beat the model ------------------------
  // A tripped honeypot is a fact about the request, not an opinion about the
  // text. Facts win.
  if (enquiry.honeypotTripped) {
    reasons.push("honeypot_tripped");
    return finalise("quarantine", "spam", reasons, []);
  }

  // The Wix form is candidate-only by construction: it has no company field and
  // is reached from a page about relocating to Bali. If it arrives on that
  // channel it is a candidate, whatever the body text claims. This closes the
  // most damaging injection: a spammer writing "I am a CEO hiring 20 closers"
  // into the form cannot manufacture a sales deal.
  if (enquiry.channel === "wix_form" && intent.startsWith("client_")) {
    reasons.push("channel_contradicts_intent:wix_form_is_candidate_only");
    intent = "unclear";
  }

  // --- 2. "unclear" is a terminal state, not a routable one -------------
  // It has no required fields and no confidence floor, so without this it would
  // fall through to the happy path. "I don't know" must always mean "a person
  // looks at it", never "file it somewhere and hope".
  if (intent === "unclear") {
    reasons.push("intent_unclear_requires_human");
    return finalise("escalate_to_human", "unclear", reasons, []);
  }

  // --- 3. Confidence floor ---------------------------------------------
  if (classification.confidence < CONFIDENCE_FLOOR[intent]) {
    reasons.push(`below_confidence_floor:${intent}:${classification.confidence.toFixed(2)}`);
    return finalise("escalate_to_human", intent, reasons, missingFor(intent, extraction));
  }

  // --- 4. Grounding failures are a smell, not just a gap ----------------
  // One dropped field is noise. Several means the model was improvising about
  // this enquiry, and nothing it said should be trusted enough to file.
  if (input.droppedFields.length >= 2) {
    reasons.push(`ungrounded_fields:${input.droppedFields.join(",")}`);
    return finalise("escalate_to_human", intent, reasons, missingFor(intent, extraction));
  }
  if (input.droppedFields.length === 1) {
    reasons.push(`ungrounded_field_dropped:${input.droppedFields[0]}`);
  }

  // --- 5. Spam ----------------------------------------------------------
  if (intent === "spam") {
    reasons.push("classified_spam_above_floor");
    return finalise("quarantine", intent, reasons, []);
  }

  // --- 6. Duplicates ----------------------------------------------------
  // An exact identity match is safe to attach to. An ambiguous company match is
  // not: merging two Australian companies with similar names corrupts the deal
  // history of both, and un-merging is manual. Ambiguity goes to a person.
  if (input.duplicateOf) {
    reasons.push(`linked_to_existing:${input.duplicateOf}`);
  }
  if (input.ambiguousCompanyMatches > 1) {
    reasons.push(`ambiguous_company_match:${input.ambiguousCompanyMatches}`);
    return finalise("escalate_to_human", intent, reasons, missingFor(intent, extraction));
  }

  // --- 7. Completeness --------------------------------------------------
  const missing = missingFor(intent, extraction);
  if (missing.length > 0) {
    // We can only ask if we have somewhere to send the question.
    const contactable = Boolean(plainValues(extraction).email ?? enquiry.fromEmail ?? enquiry.fromPhone);
    if (!contactable) {
      reasons.push("incomplete_and_uncontactable");
      return finalise("escalate_to_human", intent, reasons, missing);
    }
    reasons.push(`missing_required:${missing.join(",")}`);
    return finalise("request_missing_info", intent, reasons, missing);
  }

  // --- 8. Value-based escalation ---------------------------------------
  // Complete, confident and high value still gets a human first. A named person
  // opens a large client enquiry before any machinery touches it.
  if (intent === "client_new_business" && looksHighValue(extraction)) {
    reasons.push("high_value_client_enquiry");
    return finalise("escalate_to_human", intent, reasons, []);
  }

  reasons.push("complete_and_confident");
  return finalise("file_and_notify", intent, reasons, []);
}

function missingFor(intent: Intent, extraction: Extraction): string[] {
  const present = plainValues(extraction);
  return REQUIRED_FIELDS[intent].filter((f) => !present[f as keyof typeof present]);
}

function looksHighValue(extraction: Extraction): boolean {
  const v = plainValues(extraction);
  const head = Number.parseInt(v.headcount?.replace(/\D/g, "") ?? "", 10);
  return Number.isFinite(head) && head >= 5;
}

function finalise(
  action: Decision["action"],
  intent: Intent,
  reasons: string[],
  missingFields: string[],
): Decision {
  const route = ROUTING[intent];
  return DecisionSchema.parse({
    action,
    intent,
    destination: route.destination,
    owner: route.owner,
    slaMinutes: route.slaMinutes,
    missingFields,
    reasons,
    // Not a variable. There is no code path in this system that sends an
    // outbound message without a human pressing approve.
    requiresHumanApproval: true,
  });
}
