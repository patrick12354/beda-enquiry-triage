import type { CrmRow } from "../domain/schema.js";
import type { CrmDuplicateGroup } from "../pipeline/identity.js";

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
  status: "awaiting_approval" | "approved" | "rejected";
  decidedBy: string | null;
  decidedNote: string | null;
}

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
 */
export interface ApprovalQueuePort {
  enqueue(item: Omit<QueuedDraft, "draftId" | "status" | "decidedBy" | "decidedNote">): Promise<QueuedDraft>;
  approve(draftId: string, approver: string, note?: string): Promise<QueuedDraft>;
  reject(draftId: string, approver: string, note?: string): Promise<QueuedDraft>;
  list(): QueuedDraft[];
}

export class InMemoryApprovalQueue implements ApprovalQueuePort {
  public items: QueuedDraft[] = [];
  /** Counts sends. Stays at zero because there is no code that increments it. */
  public readonly sentCount = 0;

  async enqueue(
    input: Omit<QueuedDraft, "draftId" | "status" | "decidedBy" | "decidedNote">,
  ): Promise<QueuedDraft> {
    const prior = this.items.find((i) => i.itemId === input.itemId);
    if (prior) return prior;
    const draft: QueuedDraft = {
      ...input,
      draftId: `DRAFT-${String(this.items.length + 1).padStart(3, "0")}`,
      status: "awaiting_approval",
      decidedBy: null,
      decidedNote: null,
    };
    this.items.push(draft);
    return draft;
  }

  async approve(draftId: string, approver: string, note?: string): Promise<QueuedDraft> {
    return this.decide(draftId, "approved", approver, note);
  }

  async reject(draftId: string, approver: string, note?: string): Promise<QueuedDraft> {
    return this.decide(draftId, "rejected", approver, note);
  }

  private decide(
    draftId: string,
    status: "approved" | "rejected",
    approver: string,
    note?: string,
  ): QueuedDraft {
    const d = this.items.find((i) => i.draftId === draftId);
    if (!d) throw new Error(`No such draft: ${draftId}`);
    if (!approver.trim()) throw new Error("Approval requires a named human");
    if (d.status !== "awaiting_approval") {
      throw new Error(`${draftId} was already ${d.status} by ${d.decidedBy}`);
    }
    d.status = status;
    d.decidedBy = approver;
    d.decidedNote = note ?? null;
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
