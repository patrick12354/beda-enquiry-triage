import { RawEnquirySchema, type Decision, type RawEnquiry } from "../domain/schema.js";
import { ROUTING } from "../domain/taxonomy.js";
import { LlmUnavailableError, type LlmPort } from "../ports/llm.js";
import type { ApprovalQueuePort, CrmPort } from "../ports/crm.js";
import type { AuditPort } from "../ports/audit.js";
import { classify, extract, renderForModel } from "./classify.js";
import { normaliseEmail, normalisePhone, resolveIdentity } from "./dedupe.js";
import { checkGrounding, plainValues } from "./grounding.js";
import { decide } from "./gate.js";
import { prefilter } from "./prefilter.js";

/**
 * Orchestrator. A plain, linear state machine -- no agent framework.
 *
 * The steps are known in advance and never vary, so letting a model choose the
 * next step would add latency, cost and non-determinism in exchange for
 * flexibility this problem does not need. The agentic behaviour that IS useful
 * (working out what is missing, composing a question, drafting a reply) lives
 * inside single bounded calls, not in control flow.
 */

export interface RunDeps {
  llm: LlmPort;
  crm: CrmPort;
  approvals: ApprovalQueuePort;
  audit: AuditPort;
  seenExternalIds: Set<string>;
  /** Injected so the demo and tests do not need a real drafting model. */
  draftReply?: (ctx: { enquiry: RawEnquiry; decision: Decision }) => Promise<string>;
}

export interface RunOutcome {
  enquiryId: string;
  decision: Decision;
  crmRecordId: string | null;
  draftId: string | null;
  degraded: boolean;
}

export async function processEnquiry(input: unknown, deps: RunDeps): Promise<RunOutcome> {
  const enquiry = RawEnquirySchema.parse(input);
  const id = enquiry.externalId;
  const log = (stage: string, actor: string, summary: string, detail = {}) =>
    deps.audit.append({ enquiryId: id, stage, actor, summary, detail });

  await log("ingest", "system", "received via " + enquiry.channel, { channel: enquiry.channel });

  // 0. Replay guard. Cheapest possible check, so it runs first.
  if (deps.seenExternalIds.has(id)) {
    await log("dedupe", "system", "replay of an already-processed message; no action", {
      replay: true,
    });
    return {
      enquiryId: id,
      decision: quarantineDecision(["replay_of_processed_external_id"]),
      crmRecordId: null,
      draftId: null,
      degraded: false,
    };
  }

  // 1. Deterministic pre-filter. No tokens spent on obvious junk.
  const pre = prefilter(enquiry);
  if (pre.drop) {
    await log("prefilter", "system", "dropped before inference", {
      reasons: pre.reasons.join(","),
      inferenceSkipped: true,
    });
    deps.seenExternalIds.add(id);
    return {
      enquiryId: id,
      decision: quarantineDecision(pre.reasons),
      crmRecordId: null,
      draftId: null,
      degraded: false,
    };
  }

  // 2 + 3. Inference. Any failure here degrades to a human queue -- never to a
  //        guess, and never to a silent drop.
  let classification;
  let rawExtraction;
  try {
    classification = await classify(deps.llm, enquiry);
    const escalate = classification.confidence < 0.6 || classification.intent.startsWith("client_");
    rawExtraction = await extract(deps.llm, enquiry, escalate);
    await log("inference", "model:" + (escalate ? "escalated" : "triage"), "classified and extracted", {
      intent: classification.intent,
      confidence: classification.confidence,
      escalatedTier: escalate,
    });
  } catch (err) {
    if (!(err instanceof LlmUnavailableError)) throw err;
    await log("inference", "system", "all models failed; degrading to human triage", {
      tried: err.tried.join(","),
    });
    deps.seenExternalIds.add(id);
    return {
      enquiryId: id,
      decision: escalateDecision(["llm_unavailable"]),
      crmRecordId: null,
      draftId: null,
      degraded: true,
    };
  }

  // 4. Grounding. Deterministic verification of everything the model claimed.
  const sourceText = renderForModel(enquiry);
  const { kept, dropped } = checkGrounding(rawExtraction, sourceText);
  if (dropped.length > 0) {
    await log("grounding", "system", "dropped " + dropped.length + " ungrounded field(s)", {
      fields: dropped.map((d) => d.field + ":" + d.reason).join(","),
    });
  }
  const values = plainValues(kept);

  // 5. Identity resolution. Deterministic.
  const identity = await resolveIdentity(enquiry, values, deps.crm, deps.seenExternalIds);

  // 6. The gate. The only place an action is chosen.
  const decision = decide({
    enquiry,
    classification,
    extraction: kept,
    droppedFields: dropped.map((d) => d.field),
    duplicateOf: identity.contactId,
    ambiguousCompanyMatches: identity.ambiguousCompanyMatches,
  });
  await log("decision", "system", decision.action + " -> " + decision.owner, {
    intent: decision.intent,
    action: decision.action,
    reasons: decision.reasons.join("|"),
    missing: decision.missingFields.join(","),
  });

  // 7. Effects. Internal record writes are allowed; outbound messages are not.
  let crmRecordId: string | null = null;
  if (decision.action !== "quarantine" && ROUTING[decision.intent].autoFileRecord) {
    const contact = await deps.crm.upsertContact({
      idempotencyKey: "contact:" + id,
      // Normalisation happens on our side, not the CRM's. HubSpot will happily
      // hold jess.tran@ and jess.tran+beda@ as two people; we must not hand it
      // the chance.
      email: normaliseEmail(values.email ?? enquiry.fromEmail),
      phone: normalisePhone(enquiry.fromPhone),
      name: values.contactName ?? enquiry.fromName,
      channel: enquiry.channel,
      properties: stringify(values),
    });
    crmRecordId = contact.id;
    await deps.crm.addNote(
      contact.id,
      "[" + enquiry.channel + "] " + decision.intent + " / " + decision.action + "\n" + enquiry.body.slice(0, 1000),
      "note:" + id,
    );
    if (decision.destination === "crm_deal" && decision.action === "file_and_notify") {
      const deal = await deps.crm.createDeal({
        idempotencyKey: "deal:" + id,
        contactId: contact.id,
        pipeline: "client_placements",
        stage: "new_enquiry",
        title:
          (values.companyName ?? values.contactName ?? "Unknown") +
          " - " +
          (values.rolesSought ?? "roles TBC"),
        properties: stringify(values),
      });
      crmRecordId = deal.id;
    }
    await log("crm_write", "system", "wrote " + crmRecordId, { idempotencyKey: "contact:" + id });
  }

  // 8. Draft. Always queued for approval, never sent.
  let draftId: string | null = null;
  if (decision.action === "file_and_notify" || decision.action === "request_missing_info") {
    const to = values.email ?? enquiry.fromEmail ?? enquiry.fromPhone;
    if (to) {
      const body = deps.draftReply
        ? await deps.draftReply({ enquiry, decision })
        : fallbackDraft(decision);
      const queued = await deps.approvals.enqueue({
        enquiryId: id,
        channel: enquiry.channel,
        to,
        draftBody: body,
        intent: decision.intent,
        owner: decision.owner,
        slaMinutes: decision.slaMinutes,
        context: stringify(values),
      });
      draftId = queued.draftId;
      await log("draft_queued", "system", "reply drafted and queued for human approval", {
        draftId,
        sent: false,
      });
    }
  }

  deps.seenExternalIds.add(id);
  return { enquiryId: id, decision, crmRecordId, draftId, degraded: false };
}

function stringify(v: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(Object.entries(v).filter(([, x]) => typeof x === "string")) as Record<
    string,
    string
  >;
}

function fallbackDraft(d: Decision): string {
  return d.missingFields.length
    ? "Thanks for getting in touch with BEDA. So we can point you to the right person, could you share: " +
        d.missingFields.join(", ") +
        "?"
    : "Thanks for getting in touch with BEDA. Someone from the team will come back to you shortly.";
}

function quarantineDecision(reasons: string[]): Decision {
  return {
    action: "quarantine",
    intent: "spam",
    destination: ROUTING.spam.destination,
    owner: ROUTING.spam.owner,
    slaMinutes: ROUTING.spam.slaMinutes,
    missingFields: [],
    reasons,
    requiresHumanApproval: true,
  };
}

function escalateDecision(reasons: string[]): Decision {
  return {
    action: "escalate_to_human",
    intent: "unclear",
    destination: ROUTING.unclear.destination,
    owner: ROUTING.unclear.owner,
    slaMinutes: 60, // a degraded system must be MORE responsive, not less
    missingFields: [],
    reasons,
    requiresHumanApproval: true,
  };
}
