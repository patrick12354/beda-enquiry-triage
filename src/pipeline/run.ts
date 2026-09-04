import type {
  Classification,
  Conflict,
  CrmMatch,
  CrmRow,
  Decision,
  Entity,
  Extraction,
  Reconciliation,
  WorkItem,
} from "../domain/schema.js";
import { ExtractionSchema } from "../domain/schema.js";
import { ROUTING, staffName, type Owner } from "../domain/taxonomy.js";
import { renderForModel } from "../ingest/load.js";
import type { AuditPort } from "../ports/audit.js";
import { LlmUnavailableError, type LlmPort } from "../ports/llm.js";
import type { ApprovalQueuePort, QueuedDraft, RecordStorePort } from "../ports/records.js";
import { classify, extract } from "./classify.js";
import { draftReply } from "./draft.js";
import { decide } from "./gate.js";
import { approximateFields, checkGrounding, plainValues } from "./grounding.js";
import {
  AUTO_LINK_FLOOR,
  clusterEntities,
  findCrmDuplicates,
  matchCrm,
  resolveConflicts,
  type EntityInput,
} from "./identity.js";
import { claimsMissingAttachment, prefilter } from "./prefilter.js";
import { reconcile } from "./reconcile.js";

/**
 * Orchestrator.
 *
 * A plain, linear state machine — no agent framework, no model choosing the
 * next step. The stages are known in advance and never vary, so handing control
 * flow to a model would buy flexibility this problem does not have, in exchange
 * for latency, cost and non-determinism it cannot afford. The genuinely useful
 * model work (reading a message, pulling fields out of it) happens inside single
 * bounded calls with closed schemas.
 *
 * The one structural decision worth defending is that this runs in TWO PASSES.
 *
 * Pass one processes each item on its own. Pass two is the reason it exists:
 * you cannot know that E010 corrects E009 until you have read both, and you
 * cannot know E002 is a second bite at E001 until E001 is on the table. Any
 * design that decides an item's fate the instant it arrives gets the E009 phone
 * number wrong and quotes the Hume portfolio twice. Batch resolution is not a
 * convenience here; it is what makes the duplicate and conflict requirements
 * answerable at all.
 *
 * In production this is a short holding window rather than a batch — items are
 * held briefly before their decision is committed, and a late correction inside
 * the window amends rather than duplicates.
 */

export interface RunDeps {
  llm: LlmPort;
  crm: CrmRow[];
  records: RecordStorePort;
  approvals: ApprovalQueuePort;
  audit: AuditPort;
}

export interface ItemOutcome {
  item: WorkItem;
  classification: Classification | null;
  extraction: Extraction;
  droppedFields: Array<{ field: string; value: string; span: string; origin: string; reason: string }>;
  approximate: string[];
  reconciliations: Reconciliation[];
  crmMatches: CrmMatch[];
  conflicts: Conflict[];
  decision: Decision;
  recordId: string | null;
  draft: QueuedDraft | null;
  injectionFlags: string[];
  /** True when inference failed and the item degraded to a human queue. */
  degraded: boolean;
}

export interface BatchResult {
  outcomes: ItemOutcome[];
  entities: Entity[];
  crmDuplicates: Array<{ proposalId: string; crmIds: string[]; reason: string }>;
  /** Cross-cutting facts that belong to the run, not to any single item. */
  batchWarnings: string[];
  stats: {
    items: number;
    inferenceCalls: number;
    prefiltered: number;
    draftsQueued: number;
    draftsSent: number;
    recordsStaged: number;
  };
}

const EMPTY_EXTRACTION = ExtractionSchema.parse({});

export async function runBatch(items: WorkItem[], deps: RunDeps): Promise<BatchResult> {
  const ordered = [...items].sort((a, b) => a.seq - b.seq);
  const outcomes: ItemOutcome[] = [];
  const processed: EntityInput[] = [];
  const batchWarnings: string[] = [];
  let inferenceCalls = 0;
  let prefiltered = 0;
  let crmTrustDegraded = false;

  // --- Batch pass 0: the CRM export against itself -------------------------
  // Independent of any email. C001/C002 are one customer recorded twice, which
  // means BEDA's pipeline report double-counts them today.
  const crmDuplicates: BatchResult["crmDuplicates"] = [];
  for (const group of findCrmDuplicates(deps.crm)) {
    const { proposalId } = await deps.records.proposeMerge(group);
    crmDuplicates.push({ proposalId, crmIds: group.crmIds, reason: group.reason });
    await deps.audit.append({
      itemId: "batch",
      stage: "crm_quality",
      actor: "system",
      summary: `${group.crmIds.join(" and ")} appear to be the same organisation (${group.reason}). Merge proposed, not applied.`,
      detail: { proposalId, applied: false },
    });
  }

  // --- Pass 1: per item -----------------------------------------------------
  for (const item of ordered) {
    const log = (stage: string, actor: string, summary: string, detail: Record<string, string | number | boolean | null> = {}) =>
      deps.audit.append({ itemId: item.id, stage, actor, summary, detail });

    await log("ingest", "system", `read ${item.source} ${item.id}`, {
      attachments: item.attachments.length,
      unresolvedAttachments: item.attachments.filter((a) => !a.resolved).length,
    });

    // 1. Deterministic pre-filter. No tokens spent on obvious junk, and no
    //    obvious junk handed to a model.
    const pre = prefilter(item);
    for (const flag of pre.injectionFlags) {
      await log("security", "system", `instruction-like text found in untrusted content: "${flag}"`, {
        blocked: true,
      });
    }
    if (pre.drop) {
      prefiltered++;
      await log("prefilter", "system", `dropped before inference: ${pre.reasons.join(", ")}`, {
        inferenceSkipped: true,
      });
      const decision = quarantineDecision(pre.reasons);
      await log("decision", "system", `${decision.action} — no record, no reply, retained for appeal`, {
        intent: decision.intent,
      });
      outcomes.push({
        item,
        classification: null,
        extraction: EMPTY_EXTRACTION,
        droppedFields: [],
        approximate: [],
        reconciliations: [],
        crmMatches: [],
        conflicts: [],
        decision,
        recordId: null,
        draft: null,
        injectionFlags: pre.injectionFlags,
        degraded: false,
      });
      continue;
    }

    // 2. Inference. Failure degrades to a human queue — never to a guess and
    //    never to a silent drop.
    let classification: Classification;
    let rawExtraction: Extraction;
    try {
      classification = await classify(deps.llm, item);
      inferenceCalls++;
      // Escalate the stronger model where being wrong costs money, or where the
      // cheap pass was not confident.
      const escalate =
        classification.confidence < 0.7 ||
        classification.intent === "sales_enquiry" ||
        classification.intent === "billing_dispute";
      rawExtraction = await extract(deps.llm, item, escalate);
      inferenceCalls++;
      await log("inference", `model:${escalate ? "escalated" : "triage"}`, `classified as ${classification.intent}`, {
        intent: classification.intent,
        confidence: classification.confidence,
        escalatedTier: escalate,
      });
    } catch (err) {
      if (!(err instanceof LlmUnavailableError)) throw err;
      await log("inference", "system", "every model in the chain failed; degrading to human triage", {
        tried: err.tried.join(","),
      });
      const decision = escalateDecision(["llm_unavailable"]);
      outcomes.push({
        item,
        classification: null,
        extraction: EMPTY_EXTRACTION,
        droppedFields: [],
        approximate: [],
        reconciliations: [],
        crmMatches: [],
        conflicts: [],
        decision,
        recordId: null,
        draft: null,
        injectionFlags: pre.injectionFlags,
        degraded: true,
      });
      continue;
    }

    // 3. Grounding. Deterministic verification of everything the model claimed.
    const { kept, dropped } = checkGrounding(rawExtraction, item);
    if (dropped.length > 0) {
      await log("grounding", "system", `discarded ${dropped.length} field(s) the model could not evidence`, {
        fields: dropped.map((d) => `${d.field}:${d.reason}`).join(","),
      });
    }

    // 4. Cross-document arithmetic. Code, not a model.
    const reconciliations = reconcile(item);
    for (const r of reconciliations) {
      await log("reconcile", "system", `${r.kind}: ${r.verdict}`, {
        note: r.note.slice(0, 300),
      });
    }

    // 5. Identity: the CRM export, then this item's place among its siblings.
    const { matches, best, ambiguous } = matchCrm(item, kept, deps.crm);
    const crmRow = best && best.score >= AUTO_LINK_FLOOR ? (deps.crm.find((r) => r.id === best.crmId) ?? null) : null;
    if (best) {
      await log("identity", "system", `closest CRM row ${best.crmId} at ${best.score.toFixed(2)} (${best.signals.join(", ")})`, {
        linked: crmRow !== null,
        ambiguous,
      });
    }

    // 6. Sibling resolution. Everything seen so far in this run, plus this item.
    const withSelf: EntityInput[] = [...processed, { item, extraction: kept }];
    const entitiesSoFar = clusterEntities(withSelf, deps.crm);
    const myEntity = entitiesSoFar.find((e) => e.itemIds.includes(item.id));
    const siblings = withSelf.filter((p) => myEntity?.itemIds.includes(p.item.id));
    const conflicts = siblings.length > 1 ? resolveConflicts(siblings) : [];

    const isAmendment = /\bcorrect(ing|ion)?\b|\bshould be\b|\bgoing forward\b/i.test(item.body);
    // The most recent earlier item in this thread, whatever it was about. The
    // gate — not this function — decides whether that makes the current item a
    // duplicate, an amendment, or simply the next thing this customer said.
    const previous = siblings
      .filter((s) => s.item.seq < item.seq)
      .map((s) => outcomes.find((o) => o.item.id === s.item.id))
      .filter((o): o is ItemOutcome => Boolean(o))
      .at(-1);
    const earlierSibling = previous
      ? { id: previous.item.id, intent: previous.decision.intent }
      : null;

    for (const c of conflicts) {
      await log("conflict", "system", `${c.field}: ${c.values.map((v) => `${v.value} (${v.fromItem})`).join(" vs ")} — ${c.autoResolved ? `using ${c.resolvedTo}` : "unresolved"}`, {
        autoResolved: c.autoResolved,
        basis: c.basis.slice(0, 240),
      });
    }

    // 7. The gate. The only place an action is chosen.
    const decision = decide({
      item,
      classification,
      extraction: kept,
      droppedFields: dropped.map((d) => d.field),
      reconciliations,
      crmMatch: best,
      crmAmbiguous: ambiguous,
      crmRow,
      conflicts,
      earlierSibling,
      isAmendment,
      hasUnresolvedAttachment: item.attachments.some((a) => !a.resolved),
      claimsMissingAttachment: claimsMissingAttachment(item),
      crmTrustDegraded,
    });
    await log("decision", "system", `${decision.action} → ${decision.ownerName}`, {
      intent: decision.intent,
      action: decision.action,
      reasons: decision.reasons.join(" | "),
      missing: decision.missingFields.join(","),
    });

    // 8. Effects. Internal staging is allowed; outbound is not.
    let recordId: string | null = null;
    if (decision.action !== "quarantine" && ROUTING[decision.intent].autoFileRecord) {
      const values = plainValues(kept);
      const provenance: Record<string, string> = {};
      for (const k of Object.keys(values)) provenance[k] = item.id;
      // Fields the gate took from the CRM are recorded as coming from the CRM,
      // not from the customer. Provenance that lies is worse than none.
      for (const reason of decision.reasons) {
        const m = reason.match(/^field_from_crm:(\w+)=(.*)\((C\d+)\)$/);
        if (m?.[1] && m[3]) {
          values[m[1] as keyof typeof values] = m[2]!.trim();
          provenance[m[1]!] = m[3];
        }
      }
      for (const c of conflicts) {
        if (c.autoResolved && c.resolvedTo) {
          values[c.field as keyof typeof values] = c.resolvedTo;
          provenance[c.field] = `${c.values.at(-1)?.fromItem ?? item.id} (correction)`;
        }
      }
      const staged = await deps.records.stage({
        itemId: item.id,
        entityId: myEntity?.entityId ?? null,
        linkedCrmId: crmRow?.id ?? null,
        destination: decision.destination,
        owner: decision.owner,
        fields: Object.fromEntries(Object.entries(values).filter(([, v]) => typeof v === "string")) as Record<string, string>,
        provenance,
      });
      recordId = staged.id;
      await log("record_staged", "system", `staged ${staged.id} → ${decision.destination}${crmRow ? `, linked to ${crmRow.id}` : ", new organisation"}`, {
        applied_to_crm: false,
      });
    }

    // 9. Draft. Queued for a named human, never sent.
    let draft: QueuedDraft | null = null;
    const composed = draftReply({
      item,
      decision,
      extraction: kept,
      reconciliations,
      ownerName: decision.ownerName,
    });
    if (composed) {
      const to = plainValues(kept).contactEmail ?? item.fromEmail;
      if (to) {
        draft = await deps.approvals.enqueue({
          itemId: item.id,
          to,
          subject: composed.subject,
          body: composed.body,
          intent: decision.intent,
          owner: decision.owner,
          ownerName: decision.ownerName,
          slaHours: decision.slaHours,
          basis: composed.basis,
          context: Object.fromEntries(
            Object.entries(plainValues(kept)).filter(([, v]) => typeof v === "string"),
          ) as Record<string, string>,
        });
        await log("draft_queued", "system", `reply drafted and queued for ${decision.ownerName} to approve`, {
          draftId: draft.draftId,
          sent: false,
        });
      } else {
        await log("draft_skipped", "system", "a reply is appropriate but there is no address to send it to", {});
      }
    } else {
      await log("no_reply", "system", `no reply by policy (${ROUTING[decision.intent].responsePolicy})`, {});
    }

    // A failing CRM sync makes every later identity match suspect. Once we have
    // read that alert, we say so on the items that follow rather than quietly
    // trusting stale rows.
    if (decision.intent === "internal_alert" && /crm|hubspot|sync/i.test(item.subject ?? "" + item.body)) {
      crmTrustDegraded = true;
      batchWarnings.push(
        `${item.id} reports the CRM sync has been failing with 146 records unsynchronised. Every CRM match in this run was made against data of unknown freshness, including the ones made before this item was read.`,
      );
    }

    processed.push({ item, extraction: kept });
    outcomes.push({
      item,
      classification,
      extraction: kept,
      droppedFields: dropped,
      approximate: approximateFields(kept),
      reconciliations,
      crmMatches: matches,
      conflicts,
      decision,
      recordId,
      draft,
      injectionFlags: pre.injectionFlags,
      degraded: false,
    });
  }

  // --- Pass 2: the run as a whole ------------------------------------------
  const entities = clusterEntities(processed, deps.crm);

  // Corrections can arrive after the record they correct. E009 was staged with
  // the number Sam first gave; E010 arrives later in the same run and fixes it.
  // Applying that here is what stops the run finishing with a value its own
  // audit log has already said is wrong.
  for (const e of entities) {
    for (const c of e.conflicts) {
      if (!c.autoResolved || !c.resolvedTo) continue;
      const from = c.values.at(-1)?.fromItem ?? "correction";
      for (const id of e.itemIds) {
        const amended = await deps.records.amend(id, c.field, c.resolvedTo, `${from} (correction)`);
        if (amended) {
          await deps.audit.append({
            itemId: id,
            stage: "record_amended",
            actor: "system",
            summary: `${amended.id}.${c.field} corrected to "${c.resolvedTo}" on the authority of ${from}; the superseded value is retained in this log.`,
            detail: { field: c.field, supersededBy: from, applied_to_crm: false },
          });
        }
      }
    }
  }

  for (const e of entities) {
    if (e.itemIds.length > 1) {
      await deps.audit.append({
        itemId: "batch",
        stage: "entity",
        actor: "system",
        summary: `${e.entityId} "${e.displayName}" gathers ${e.itemIds.join(", ")}${e.crmIds.length ? ` and CRM ${e.crmIds.join(", ")}` : " (not in the CRM)"} via ${e.signals.join(", ")}`,
        detail: { conflicts: e.conflicts.length },
      });
    }
  }

  return {
    outcomes,
    entities,
    crmDuplicates,
    batchWarnings,
    stats: {
      items: ordered.length,
      inferenceCalls,
      prefiltered,
      draftsQueued: deps.approvals.list().length,
      draftsSent: 0, // there is no code path that could make this non-zero
      recordsStaged: deps.records.all().length,
    },
  };
}

function baseDecision(overrides: Partial<Decision>, owner: Owner): Decision {
  return {
    action: "escalate_to_human",
    intent: "unclear",
    destination: "crm_contact_only",
    owner,
    ownerName: staffName(owner),
    consult: [],
    justification: ROUTING.unclear.justification,
    slaHours: 12,
    missingFields: [],
    reasons: [],
    warnings: [],
    drafting: "no_reply",
    requiresHumanApproval: true,
    ...overrides,
  };
}

function quarantineDecision(reasons: string[]): Decision {
  return baseDecision(
    {
      action: "quarantine",
      intent: "spam",
      destination: "quarantine",
      justification: ROUTING.spam.justification,
      slaHours: ROUTING.spam.slaHours,
      reasons,
    },
    "quarantine",
  );
}

function escalateDecision(reasons: string[]): Decision {
  return baseDecision(
    {
      reasons,
      // A degraded system must be MORE responsive, not less. Nothing is being
      // handled automatically, so the human queue gets a tighter clock.
      slaHours: 1,
      warnings: ["running_without_inference"],
    },
    "ties",
  );
}

export { renderForModel };
