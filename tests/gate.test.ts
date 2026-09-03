import { describe, expect, it } from "vitest";
import { decide } from "../src/pipeline/gate.js";
import { RawEnquirySchema, type Classification, type Extraction } from "../src/domain/schema.js";

const EMPTY: Extraction = {
  contactName: null,
  email: null,
  phone: null,
  companyName: null,
  companyWebsite: null,
  track: null,
  currentLocation: null,
  currentRole: null,
  rolesSought: null,
  headcount: null,
  timeline: null,
  budget: null,
  issueSummary: null,
};

const g = (v: string) => ({ value: v, sourceSpan: v });

function enquiry(over: Record<string, unknown> = {}) {
  return RawEnquirySchema.parse({
    externalId: "x1",
    channel: "email",
    receivedAt: "2026-09-03T02:00:00.000Z",
    fromName: null,
    fromEmail: "someone@example.com",
    fromPhone: null,
    subject: null,
    body: "hello",
    formFields: {},
    attachments: [],
    honeypotTripped: false,
    ...over,
  });
}

function classification(over: Partial<Classification> = {}): Classification {
  return {
    intent: "client_new_business",
    confidence: 0.95,
    rationale: "r",
    evidence: "e",
    ...over,
  };
}

const COMPLETE_CLIENT: Extraction = {
  ...EMPTY,
  companyName: g("Acme Pty Ltd"),
  contactName: g("Sam"),
  email: g("sam@acme.com.au"),
  rolesSought: g("appointment setters"),
};

const base = {
  droppedFields: [] as string[],
  duplicateOf: null,
  ambiguousCompanyMatches: 0,
};

describe("gate", () => {
  it("files a complete, confident, modest client enquiry", () => {
    const d = decide({
      ...base,
      enquiry: enquiry(),
      classification: classification(),
      extraction: COMPLETE_CLIENT,
    });
    expect(d.action).toBe("file_and_notify");
    expect(d.destination).toBe("crm_deal");
    expect(d.owner).toBe("#beda-newbiz");
  });

  it("never marks anything as safe to send without approval", () => {
    for (const intent of ["client_new_business", "candidate_application", "support", "spam"] as const) {
      const d = decide({
        ...base,
        enquiry: enquiry(),
        classification: classification({ intent, confidence: 0.99 }),
        extraction: COMPLETE_CLIENT,
      });
      expect(d.requiresHumanApproval).toBe(true);
    }
  });

  it("asks for missing fields rather than guessing them", () => {
    const d = decide({
      ...base,
      enquiry: enquiry(),
      classification: classification(),
      extraction: { ...EMPTY, contactName: g("Sam"), email: g("sam@acme.com.au") },
    });
    expect(d.action).toBe("request_missing_info");
    expect(d.missingFields).toEqual(["companyName", "rolesSought"]);
  });

  it("escalates when it is incomplete AND there is no way to reply", () => {
    const d = decide({
      ...base,
      enquiry: enquiry({ fromEmail: null, fromPhone: null }),
      classification: classification(),
      extraction: { ...EMPTY, contactName: g("Sam") },
    });
    expect(d.action).toBe("escalate_to_human");
    expect(d.reasons).toContain("incomplete_and_uncontactable");
  });

  it("escalates below the per-intent confidence floor", () => {
    const d = decide({
      ...base,
      enquiry: enquiry(),
      classification: classification({ confidence: 0.7 }),
      extraction: COMPLETE_CLIENT,
    });
    expect(d.action).toBe("escalate_to_human");
    expect(d.reasons.some((r) => r.startsWith("below_confidence_floor"))).toBe(true);
  });

  it("requires near-certainty before calling something spam", () => {
    const d = decide({
      ...base,
      enquiry: enquiry(),
      classification: classification({ intent: "spam", confidence: 0.9 }),
      extraction: EMPTY,
    });
    // 0.9 is confident, but not confident enough to ignore a human being.
    expect(d.action).toBe("escalate_to_human");
  });

  it("quarantines spam above the floor without writing a record", () => {
    const d = decide({
      ...base,
      enquiry: enquiry(),
      classification: classification({ intent: "spam", confidence: 0.97 }),
      extraction: EMPTY,
    });
    expect(d.action).toBe("quarantine");
    expect(d.destination).toBe("no_record");
  });

  it("lets a tripped honeypot override whatever the model said", () => {
    const d = decide({
      ...base,
      enquiry: enquiry({ honeypotTripped: true }),
      classification: classification({ intent: "client_new_business", confidence: 1 }),
      extraction: COMPLETE_CLIENT,
    });
    expect(d.action).toBe("quarantine");
    expect(d.reasons).toContain("honeypot_tripped");
  });

  it("refuses to create a client deal from the candidate-only web form", () => {
    // This is the prompt-injection defence: the channel is a fact, the intent is
    // an opinion, and the fact wins.
    const d = decide({
      ...base,
      enquiry: enquiry({ channel: "wix_form" }),
      classification: classification({ intent: "client_new_business", confidence: 1 }),
      extraction: COMPLETE_CLIENT,
    });
    expect(d.intent).toBe("unclear");
    expect(d.destination).toBe("no_record");
    expect(d.reasons).toContain("channel_contradicts_intent:wix_form_is_candidate_only");
  });

  it("escalates a high-headcount client enquiry even when it is complete", () => {
    const d = decide({
      ...base,
      enquiry: enquiry(),
      classification: classification(),
      extraction: { ...COMPLETE_CLIENT, headcount: g("12") },
    });
    expect(d.action).toBe("escalate_to_human");
    expect(d.reasons).toContain("high_value_client_enquiry");
  });

  it("escalates when several fields failed the grounding check", () => {
    const d = decide({
      ...base,
      droppedFields: ["companyName", "budget"],
      enquiry: enquiry(),
      classification: classification(),
      extraction: COMPLETE_CLIENT,
    });
    expect(d.action).toBe("escalate_to_human");
  });

  it("escalates an ambiguous company match instead of merging", () => {
    const d = decide({
      ...base,
      ambiguousCompanyMatches: 3,
      enquiry: enquiry(),
      classification: classification(),
      extraction: COMPLETE_CLIENT,
    });
    expect(d.action).toBe("escalate_to_human");
    expect(d.reasons).toContain("ambiguous_company_match:3");
  });
});
