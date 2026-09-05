import { beforeEach, describe, expect, it } from "vitest";
import type { CrmRow } from "../src/domain/schema.js";
import { InMemoryAudit } from "../src/ports/audit.js";
import {
  currentApprovalState,
  InMemoryApprovalQueue,
  InMemoryRecordStore,
  StaleApprovalError,
} from "../src/ports/records.js";

/**
 * An approval is a statement about a specific set of facts, not a permanent
 * licence to act on an item. A draft can sit in the queue while the staged
 * record is amended by a later correction, or while the linked CRM row changes
 * underneath it — this system does both — and an approval given before that
 * must not execute after it.
 *
 * Two cases, because there are only two: the state held, or it moved.
 */

const CRM: CrmRow[] = [
  {
    id: "C001",
    company: "Riverbend Cold Storage",
    contact: "Sam Ortiz",
    email: "sam@riverbend.test",
    phone: "0400 111 222",
    location: "Wodonga VIC",
    stage: "qualified",
    interest: "rooftop solar",
    status: "open",
  },
];

let records: InMemoryRecordStore;
let audit: InMemoryAudit;
let queue: InMemoryApprovalQueue;

async function queueDraft() {
  const staged = await records.stage({
    itemId: "E009",
    entityId: "ENT-1",
    linkedCrmId: "C001",
    destination: "sales",
    owner: "sales",
    fields: { companyName: "Riverbend Cold Storage", contactPhone: "0400 111 222" },
    provenance: { companyName: "E009", contactPhone: "E009" },
  });
  return queue.enqueue({
    itemId: "E009",
    to: "sam@riverbend.test",
    subject: "Your rooftop solar enquiry",
    body: "Thanks Sam — we have your details and will come back with a proposal.",
    intent: "sales_enquiry",
    owner: "sales",
    ownerName: "Priya Raman",
    slaHours: 24,
    basis: ["contact details as supplied in E009"],
    context: { contactPhone: "0400 111 222" },
    recordId: staged.id,
    crmId: "C001",
    state: currentApprovalState({ recordId: staged.id, crmId: "C001" }, records, CRM),
  });
}

beforeEach(() => {
  records = new InMemoryRecordStore();
  audit = new InMemoryAudit();
  queue = new InMemoryApprovalQueue(audit);
});

describe("an approval is only valid against the state it was given on", () => {
  it("applies when the record and CRM row have not moved since queueing", async () => {
    const draft = await queueDraft();

    const approved = await queue.approve(
      draft.draftId,
      "Priya Raman",
      currentApprovalState(draft, records, CRM),
    );

    expect(approved.status).toBe("approved");
    expect(approved.decidedBy).toBe("Priya Raman");
    expect(approved.conflict).toBeNull();

    const trail = await audit.forItem("E009");
    expect(trail.map((e) => e.stage)).toContain("approval_revalidated");
    // The chain is what someone reads afterwards, so it has to still verify.
    expect((await audit.verify()).ok).toBe(true);
  });

  it("blocks the approval and returns the item for review when the record changed", async () => {
    const draft = await queueDraft();

    // A correction arrives after the draft was queued — exactly what pass 2 of
    // the run does when E010 fixes the number E009 was staged with.
    await records.amend("E009", "contactPhone", "0400 999 888", "E010 (correction)");

    await expect(
      queue.approve(draft.draftId, "Priya Raman", currentApprovalState(draft, records, CRM)),
    ).rejects.toBeInstanceOf(StaleApprovalError);

    // Nothing was applied: not approved, and nobody is recorded as having
    // cleared it, because on the state that now exists nobody has.
    const after = queue.list().find((d) => d.draftId === draft.draftId)!;
    expect(after.status).toBe("stale");
    expect(after.decidedBy).toBeNull();
    expect(after.conflict?.expected).toBe(draft.stateFingerprint);
    expect(after.conflict?.actual).not.toBe(draft.stateFingerprint);
    expect(after.conflict?.detectedBy).toBe("Priya Raman");

    // The conflict is a first-class event in the audit trail, not a log line.
    const blocked = (await audit.forItem("E009")).find((e) => e.stage === "approval_blocked_stale");
    expect(blocked).toBeDefined();
    expect(blocked!.actor).toBe("user:Priya Raman");
    expect(blocked!.detail.applied).toBe(false);
    expect(blocked!.detail.sent).toBe(false);
    expect((await audit.verify()).ok).toBe(true);

    // And the item genuinely comes back: re-queuing against the new state
    // produces a fresh draft for a human to look at, rather than silently
    // reviving the one that was already reviewed.
    const requeued = await queueDraft();
    expect(requeued.draftId).not.toBe(draft.draftId);
    expect(requeued.status).toBe("awaiting_approval");
    expect(requeued.stateFingerprint).not.toBe(draft.stateFingerprint);
  });
});
