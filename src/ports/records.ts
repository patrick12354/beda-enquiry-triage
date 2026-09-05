import { createHash } from "node:crypto";

import type { CrmRow } from "../domain/schema.js";
import type { CrmDuplicateGroup } from "../pipeline/identity.js";
import type { AuditPort } from "./audit.js";

/**
 * Systems of record, behind a port.
 *
 * The supplied CRM export is READ-ONLY in this build, and that is a deliberate
 * safety property rather than an unfinished feature. The pack's own E011 tells
 * us the CRM sync has been failing since 02:14 with 146 records unsynchronised.
 * Writing into a system that is known to be in an inconsistent state is how you
 * turn a sync failure into a data-loss incident.
 *
 * So the pipeline writes to its own staging store, records what it WOULD change
 * in the CRM as a proposal, and leaves the merge for a human with the sync
 * fixed. Every proposal is reversible because none of them have been applied.
 */

export interface StagedRecord {
  id: string;
  itemId: string;
  entityId: string | null;
  /** The CRM row this attaches to, when identity was confident enough. */
  linkedCrmId: string | null;
  destination: string;
  owner: string;
  fields: Record<string, string>;
  /** Where each field came from: an item id, or a CRM row id. */
  provenance: Record<string, string>;
}

export interface RecordStorePort {
  stage(input: Omit<StagedRecord, "id">): Promise<StagedRecord>;
  /**
   * Correct one field on a record already staged.
   *
   * Needed because a correction can arrive after the record it corrects. E009
   * is staged with the phone number Sam first gave; E010 arrives later in the
   * same run and fixes it. Without this the run would end holding a number its
   * own audit log says is wrong.
   */
  amend(itemId: string, field: string, value: string, provenance: string): Promise<StagedRecord | null>;
  proposeMerge(group: CrmDuplicateGroup): Promise<{ proposalId: string }>;
  all(): StagedRecord[];
}

export class InMemoryRecordStore implements RecordStorePort {
  public records: StagedRecord[] = [];
  public mergeProposals: Array<CrmDuplicateGroup & { proposalId: string; applied: false }> = [];
  private seen = new Map<string, StagedRecord>();

  async stage(input: Omit<StagedRecord, "id">): Promise<StagedRecord> {
    // Idempotent on item id. A replayed item must not create a second record.
    const existing = this.seen.get(input.itemId);
    if (existing) return existing;
    const rec: StagedRecord = { ...input, id: `REC-${String(this.records.length + 1).padStart(3, "0")}` };
    this.records.push(rec);
    this.seen.set(input.itemId, rec);
    return rec;
  }

  async amend(
    itemId: string,
    field: string,
    value: string,
    provenance: string,
  ): Promise<StagedRecord | null> {
    const rec = this.seen.get(itemId);
    if (!rec || rec.fields[field] === value) return null;
    rec.fields[field] = value;
    rec.provenance[field] = provenance;
    return rec;
  }

  async proposeMerge(group: CrmDuplicateGroup): Promise<{ proposalId: string }> {
    const key = group.crmIds.join("+");
    const prior = this.mergeProposals.find((p) => p.crmIds.join("+") === key);
    if (prior) return { proposalId: prior.proposalId };
    const proposalId = `MERGE-${String(this.mergeProposals.length + 1).padStart(3, "0")}`;
    // `applied: false` is a literal. Nothing in this class can set it true;
    // applying a merge is a separate, human-initiated operation that this build
    // does not implement.
    this.mergeProposals.push({ ...group, proposalId, applied: false });
    return { proposalId };
  }

  all(): StagedRecord[] {
    return this.records;
  }
}

/** ------------------------------------------------------------------
 *  The approval boundary
 *  ------------------------------------------------------------------ */

/**
 * The state a draft was approved AGAINST.
 *
 * An approval is not standing permission to act on an item forever. It is a
 * named human saying "given these facts, this reply is correct". If the facts
 * move while the draft sits in the queue, the approval no longer refers to
 * anything that exists.
 *
 * That gap is not hypothetical here. Pass 2 of the run amends staged records
 * when a correction arrives after the item it corrects — E010 fixes the phone
 * number E009 was staged with — and the pack's own E011 says the CRM sync has
 * been failing, so a linked row can move underneath a queued draft at any time.
 *
 * The two things a draft actually depends on are captured here: the staged
 * record's fields, and the CRM row it was linked to.
 */
export interface ApprovalState {
  /** The CRM row the draft was linked to, as it stood. Null when unlinked. */
  crmRow: CrmRow | null;
  /** The staged record's fields, as they stood. */
  fields: Record<string, string>;
}

/**
 * A content hash of that state. Deterministic — keys are sorted — so identical
 * state always produces an identical fingerprint, and the audit log stays
 * diffable in tests.
 *
 * A fingerprint rather than a version counter, deliberately. A counter has to
 * be bumped by every writer, and the writer that forgets to bump it is exactly
 * the one that causes the incident. A hash of the content cannot be forgotten.
 */
export function fingerprintState(state: ApprovalState): string {
  const canonical = JSON.stringify({
    crm: state.crmRow ? sorted(state.crmRow as unknown as Record<string, unknown>) : null,
    fields: sorted(state.fields),
  });
  return createHash("sha256").update(canonical).digest("hex");
}

function sorted(o: Record<string, unknown>): Array<[string, unknown]> {
  return Object.entries(o)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
}

/** Rebuild the CURRENT state of what a draft depends on, from the live stores. */
export function currentApprovalState(
  draft: Pick<QueuedDraft, "recordId" | "crmId">,
  records: RecordStorePort,
  crm: CrmRow[],
): ApprovalState {
  const record = draft.recordId ? records.all().find((r) => r.id === draft.recordId) : undefined;
  return {
    crmRow: draft.crmId ? (crm.find((r) => r.id === draft.crmId) ?? null) : null,
    fields: record ? { ...record.fields } : {},
  };
}

/**
 * Raised when an approval is applied to a draft whose underlying state moved.
 *
 * An error rather than a return value, on purpose: a caller cannot accidentally
 * treat a blocked approval as a successful one.
 */
export class StaleApprovalError extends Error {
  readonly draft: QueuedDraft;
  readonly expectedFingerprint: string;
  readonly actualFingerprint: string;

  constructor(draft: QueuedDraft, actualFingerprint: string, detail?: string) {
    super(
      `${draft.draftId} was reviewed against state ${draft.stateFingerprint.slice(0, 12)}, but the ` +
        `record or CRM row it depends on now hashes to ${actualFingerprint.slice(0, 12) || "something else"}. ` +
        `The approval was not applied and the item is returned for fresh review` +
        `${detail ? ` (${detail})` : ""}.`,
    );
    this.name = "StaleApprovalError";
    this.draft = draft;
    this.expectedFingerprint = draft.stateFingerprint;
    this.actualFingerprint = actualFingerprint;
  }
}

export interface QueuedDraft {
  draftId: string;
  itemId: string;
  to: string;
  subject: string;
  body: string;
  intent: string;
  owner: string;
  ownerName: string;
  slaHours: number;
  /** Why the reviewer should believe each claim in the draft. */
  basis: string[];
  /** Facts behind the draft, so the reviewer need not open three tabs. */
  context: Record<string, string>;
  /** The staged record and CRM row this draft depends on, for revalidation. */
  recordId: string | null;
  crmId: string | null;
  /** Hash of that state at the moment the item entered the queue. */
  stateFingerprint: string;
  status: "awaiting_approval" | "approved" | "rejected" | "stale";
  decidedBy: string | null;
  decidedNote: string | null;
  /** Set only when an approval was blocked because the state had moved. */
  conflict: { expected: string; actual: string; detectedBy: string } | null;
}

export type DraftInput = Omit<
  QueuedDraft,
  "draftId" | "status" | "decidedBy" | "decidedNote" | "stateFingerprint" | "conflict"
> & {
  /** The state as it stands at enqueue time. The queue hashes it itself. */
  state: ApprovalState;
};

/**
 * The queue. Note what this interface does NOT have: a `send`.
 *
 * `approve` marks a draft as cleared by a named human and returns it. Actually
 * transmitting it is the job of a separate outbound service that this build
 * does not include and that the pipeline holds no reference to. That is the
 * whole point of the split: the machine can prepare and it can propose, and the
 * capability to speak to a customer lives somewhere it cannot reach.
 *
 * The consequence worth stating plainly: a total compromise of the classifier,
 * the extractor and the drafting model — every model in the system returning
 * attacker-chosen output — still sends zero emails.
 *
 * `approve` takes the CURRENT state as an argument rather than trusting the
 * snapshot it stored. The revalidation lives here, at the boundary, rather than
 * in each caller, because a check a caller can forget to perform is not a
 * control — it is a convention.
 */
export interface ApprovalQueuePort {
  enqueue(item: DraftInput): Promise<QueuedDraft>;
  approve(draftId: string, approver: string, current: ApprovalState, note?: string): Promise<QueuedDraft>;
  reject(draftId: string, approver: string, note?: string): Promise<QueuedDraft>;
  list(): QueuedDraft[];
}

export class InMemoryApprovalQueue implements ApprovalQueuePort {
  public items: QueuedDraft[] = [];
  /** Counts sends. Stays at zero because there is no code that increments it. */
  public readonly sentCount = 0;

  /** Optional so a bare queue can be constructed; wired in the demo and server. */
  constructor(private readonly audit?: AuditPort) {}

  async enqueue(input: DraftInput): Promise<QueuedDraft> {
    const { state, ...rest } = input;
    // Idempotent on item id: a replayed item must not create a second draft.
    // A draft that went stale is the exception. It was withdrawn precisely so a
    // human would look again, and re-queuing it against the new state is that
    // fresh review — the stale draft stays in the list as the record of why.
    const prior = this.items.find((i) => i.itemId === input.itemId && i.status !== "stale");
    if (prior) return prior;
    const draft: QueuedDraft = {
      ...rest,
      draftId: `DRAFT-${String(this.items.length + 1).padStart(3, "0")}`,
      stateFingerprint: fingerprintState(state),
      status: "awaiting_approval",
      decidedBy: null,
      decidedNote: null,
      conflict: null,
    };
    this.items.push(draft);
    return draft;
  }

  /**
   * Apply a named human's approval — but only to the state that human reviewed.
   *
   * The fingerprint is recomputed from the live stores and compared against the
   * one taken at queue time. Unchanged, the approval stands. Changed, nothing is
   * applied, the draft is marked stale, and the conflict is written into the
   * hash-chained audit log where it cannot be quietly removed later.
   */
  async approve(
    draftId: string,
    approver: string,
    current: ApprovalState,
    note?: string,
  ): Promise<QueuedDraft> {
    const d = this.mustFind(draftId);
    const who = approver.trim();
    if (!who) throw new Error("Approval requires a named human");
    if (d.status === "stale") {
      throw new StaleApprovalError(d, d.conflict?.actual ?? "", "already returned for fresh review");
    }
    if (d.status !== "awaiting_approval") {
      throw new Error(`${draftId} was already ${d.status} by ${d.decidedBy}`);
    }

    const actual = fingerprintState(current);
    if (actual !== d.stateFingerprint) {
      d.status = "stale";
      d.conflict = { expected: d.stateFingerprint, actual, detectedBy: who };
      await this.audit?.append({
        itemId: d.itemId,
        stage: "approval_blocked_stale",
        actor: `user:${who}`,
        summary:
          `${d.draftId} was NOT applied. It was reviewed against the record as it stood when the draft ` +
          `was queued, and the underlying record or CRM row has changed since. The item is returned ` +
          `for fresh review.`,
        detail: {
          draftId: d.draftId,
          expected_fingerprint: d.stateFingerprint.slice(0, 16),
          actual_fingerprint: actual.slice(0, 16),
          applied: false,
          sent: false,
        },
      });
      throw new StaleApprovalError(d, actual);
    }

    d.status = "approved";
    d.decidedBy = who;
    d.decidedNote = note ?? null;
    await this.audit?.append({
      itemId: d.itemId,
      stage: "approval_revalidated",
      actor: `user:${who}`,
      summary: `${d.draftId} still matches the state it was drafted against, so the approval is valid.`,
      detail: { draftId: d.draftId, fingerprint: actual.slice(0, 16), applied: true, sent: false },
    });
    return d;
  }

  /**
   * Rejection needs no revalidation. Declining to act on state that has moved is
   * the same safe outcome either way; only the acting direction needs a gate.
   */
  async reject(draftId: string, approver: string, note?: string): Promise<QueuedDraft> {
    const d = this.mustFind(draftId);
    if (!approver.trim()) throw new Error("Approval requires a named human");
    if (d.status !== "awaiting_approval") {
      throw new Error(`${draftId} was already ${d.status}${d.decidedBy ? ` by ${d.decidedBy}` : ""}`);
    }
    d.status = "rejected";
    d.decidedBy = approver.trim();
    d.decidedNote = note ?? null;
    return d;
  }

  private mustFind(draftId: string): QueuedDraft {
    const d = this.items.find((i) => i.draftId === draftId);
    if (!d) throw new Error(`No such draft: ${draftId}`);
    return d;
  }

  list(): QueuedDraft[] {
    return this.items;
  }
}

/** Read-only view of the supplied CRM export. */
export class CrmReadModel {
  constructor(public readonly rows: CrmRow[]) {}
  byId(id: string): CrmRow | null {
    return this.rows.find((r) => r.id === id) ?? null;
  }
}
