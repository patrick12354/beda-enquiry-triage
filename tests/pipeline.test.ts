import { beforeEach, describe, expect, it } from "vitest";
import { processEnquiry, type RunDeps } from "../src/pipeline/run.js";
import { InMemoryAudit } from "../src/ports/audit.js";
import { InMemoryApprovalQueue, InMemoryCrm } from "../src/ports/crm.js";
import { ScriptedLlm } from "../src/ports/llm.js";
import { ALL_FIXTURES, scriptMap } from "../src/fixtures/enquiries.js";
import { normaliseEmail, normalisePhone } from "../src/pipeline/dedupe.js";

function deps(over: { llm?: RunDeps["llm"] } = {}) {
  const crm = new InMemoryCrm();
  const approvals = new InMemoryApprovalQueue();
  const audit = new InMemoryAudit();
  const llm = over.llm ?? new ScriptedLlm(scriptMap());
  const d: RunDeps = { llm, crm, approvals, audit, seenExternalIds: new Set<string>() };
  return { ...d, crm, approvals, audit, llm };
}

describe("end to end", () => {
  let d: ReturnType<typeof deps>;
  beforeEach(() => {
    d = deps();
  });

  it("files a clean client enquiry as a deal and queues a draft", async () => {
    const out = await processEnquiry(ALL_FIXTURES.CLIENT_COMPLETE, d);
    expect(out.decision.action).toBe("file_and_notify");
    expect(d.crm.deals).toHaveLength(1);
    expect(d.crm.deals[0]?.title).toContain("North Shore Digital");
    expect(d.approvals.items).toHaveLength(1);
  });

  it("sends nothing, ever -- drafts only reach the approval queue", async () => {
    for (const f of Object.values(ALL_FIXTURES)) {
      const fresh = deps();
      const out = await processEnquiry(f, fresh);
      expect(out.decision.requiresHumanApproval).toBe(true);
      // The only outbound surface in the whole system is the approval queue.
      for (const item of fresh.approvals.items) {
        expect(item.draftBody.length).toBeGreaterThan(0);
      }
    }
  });

  it("routes the candidate form to the ATS, not the sales pipeline", async () => {
    const out = await processEnquiry(ALL_FIXTURES.CANDIDATE_FORM, d);
    expect(out.decision.intent).toBe("candidate_application");
    expect(out.decision.destination).toBe("ats_candidate");
    expect(d.crm.deals).toHaveLength(0);
  });

  it("reads an agency owner who wants a job as a candidate, not a client", async () => {
    const out = await processEnquiry(ALL_FIXTURES.CANDIDATE_LOOKS_LIKE_CLIENT, d);
    expect(out.decision.intent).toBe("candidate_application");
    expect(d.crm.deals).toHaveLength(0);
  });

  it("escalates a 12-person client enquiry to a person", async () => {
    const out = await processEnquiry(ALL_FIXTURES.CLIENT_HIGH_VALUE, d);
    expect(out.decision.action).toBe("escalate_to_human");
    expect(out.decision.reasons).toContain("high_value_client_enquiry");
    expect(d.crm.deals).toHaveLength(0); // no deal until a human has looked
  });

  it("asks for what is missing instead of inventing it", async () => {
    const out = await processEnquiry(ALL_FIXTURES.INCOMPLETE_CLIENT, d);
    expect(out.decision.action).toBe("request_missing_info");
    expect(out.decision.missingFields).toContain("companyName");
    expect(d.approvals.items[0]?.draftBody).toContain("companyName");
  });

  it("drops obvious spam before spending a single token", async () => {
    const out = await processEnquiry(ALL_FIXTURES.SPAM_OBVIOUS, d);
    expect(out.decision.action).toBe("quarantine");
    expect((d.llm as ScriptedLlm).calls).toHaveLength(0);
    expect(d.crm.contacts.size).toBe(0);
  });

  it("ignores an injected instruction arriving through the public form", async () => {
    const out = await processEnquiry(ALL_FIXTURES.INJECTION_ATTEMPT, d);
    // The scripted model was fooled into client_new_business @ 1.0 confidence.
    expect(out.decision.intent).toBe("unclear");
    expect(out.decision.action).not.toBe("file_and_notify");
    expect(d.crm.deals).toHaveLength(0);
  });

  it("does not double-file when the same enquiry is re-delivered", async () => {
    await processEnquiry(ALL_FIXTURES.CLIENT_COMPLETE, d);
    await processEnquiry(ALL_FIXTURES.CLIENT_COMPLETE, d); // exact webhook replay
    await processEnquiry(ALL_FIXTURES.CLIENT_DUPLICATE, d); // human resend
    expect(d.crm.deals).toHaveLength(2); // two distinct messages...
    expect(d.crm.contacts.size).toBe(1); // ...but one contact
  });

  it("degrades to a human queue when every model is down", async () => {
    const failing = deps({ llm: new ScriptedLlm(scriptMap(), new Set(["Classification"])) });
    const out = await processEnquiry(ALL_FIXTURES.CLIENT_COMPLETE, failing);
    expect(out.degraded).toBe(true);
    expect(out.decision.action).toBe("escalate_to_human");
    expect(out.decision.reasons).toContain("llm_unavailable");
    // A degraded system gets a TIGHTER SLA, not a looser one.
    expect(out.decision.slaMinutes).toBe(60);
    expect(failing.crm.deals).toHaveLength(0);
  });

  it("keeps an unbroken, tamper-evident audit trail", async () => {
    await processEnquiry(ALL_FIXTURES.CLIENT_COMPLETE, d);
    const trail = await d.audit.forEnquiry("email-001");
    expect(trail.map((e) => e.stage)).toEqual([
      "ingest",
      "inference",
      "decision",
      "crm_write",
      "draft_queued",
    ]);
    expect((await d.audit.verify()).ok).toBe(true);

    d.audit._tamper(1, "nothing to see here");
    const after = await d.audit.verify();
    expect(after.ok).toBe(false);
    expect(after.brokenAtSeq).toBe(1);
  });
});

describe("identity normalisation", () => {
  it("treats gmail dots and plus tags as the same person", () => {
    expect(normaliseEmail("Jess.Tran+beda@Gmail.com")).toBe("jesstran@gmail.com");
    expect(normaliseEmail("jesstran@gmail.com")).toBe("jesstran@gmail.com");
  });

  it("does not strip dots outside gmail, where they are significant", () => {
    expect(normaliseEmail("first.last@northshoredigital.com.au")).toBe(
      "first.last@northshoredigital.com.au",
    );
  });

  it("resolves local-format numbers from both countries in scope", () => {
    expect(normalisePhone("0412 887 340", "61")).toBe("+61412887340");
    expect(normalisePhone("0812-3456-7890")).toBe("+6281234567890");
    expect(normalisePhone("+61 412 887 340")).toBe("+61412887340");
  });
});

describe("candidate identity across submissions", () => {
  it("recognises the same candidate behind a gmail alias", async () => {
    const d = deps();
    await processEnquiry(ALL_FIXTURES.CANDIDATE_FORM, d);
    await processEnquiry(ALL_FIXTURES.CANDIDATE_FORM_REPEAT, d);
    // Two submissions, one human. Normalisation is ours to do -- the CRM would
    // happily store these as two separate people.
    expect(d.crm.contacts.size).toBe(1);
  });
});
