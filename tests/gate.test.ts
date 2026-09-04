import { describe, expect, it } from "vitest";
import {
  ExtractionSchema,
  WorkItemSchema,
  type CrmRow,
  type Extraction,
} from "../src/domain/schema.js";
import { decide, qualify, type GateInput } from "../src/pipeline/gate.js";

/**
 * The gate is the only place an action is chosen, so it gets the densest tests.
 * Each one states a policy BEDA could disagree with — which is the point of
 * having the policy in code rather than in a prompt.
 */

const f = (value: string, sourceSpan = value) => ({ value, sourceSpan, origin: "body", approximate: false });

const base = (over: Partial<GateInput> = {}): GateInput => ({
  item: WorkItemSchema.parse({
    id: "T001",
    seq: 1,
    source: "email",
    fromName: null,
    fromEmail: "someone@example.test",
    subject: "s",
    body: "b",
    attachments: [],
  }),
  classification: { intent: "sales_enquiry", confidence: 0.9, rationale: "r", evidence: "e" },
  extraction: ExtractionSchema.parse({}),
  droppedFields: [],
  reconciliations: [],
  crmMatch: null,
  crmAmbiguous: false,
  crmRow: null,
  conflicts: [],
  earlierSibling: null,
  isAmendment: false,
  hasUnresolvedAttachment: false,
  claimsMissingAttachment: false,
  crmTrustDegraded: false,
  ...over,
});

const complete: Extraction = ExtractionSchema.parse({
  contactName: f("Amelia Grant"),
  companyName: f("Hume Logistics Pty Ltd"),
  siteLocation: f("Truganina, Dandenong and Epping"),
  annualConsumption: f("about 2.1 GWh per year"),
});

describe("the invariant", () => {
  it("marks every decision as requiring human approval", () => {
    for (const intent of ["sales_enquiry", "spam", "internal_alert", "unclear"] as const) {
      const d = decide(base({ classification: { intent, confidence: 0.99, rationale: "", evidence: "" } }));
      expect(d.requiresHumanApproval).toBe(true);
    }
  });
});

describe("uncertainty", () => {
  it("treats unclear as terminal rather than routable", () => {
    const d = decide(base({ classification: { intent: "unclear", confidence: 1, rationale: "", evidence: "" } }));
    expect(d.action).toBe("escalate_to_human");
    expect(d.reasons).toContain("intent_unclear_requires_human");
  });

  it("sends a low-confidence call to a person instead of acting on it", () => {
    const d = decide(base({ classification: { intent: "sales_enquiry", confidence: 0.4, rationale: "", evidence: "" } }));
    expect(d.action).toBe("escalate_to_human");
  });

  it("holds spam to a near-certainty floor, because a binned customer is silent", () => {
    const nearly = decide(base({ classification: { intent: "spam", confidence: 0.9, rationale: "", evidence: "" } }));
    expect(nearly.action).toBe("escalate_to_human");
    const certain = decide(base({ classification: { intent: "spam", confidence: 0.97, rationale: "", evidence: "" } }));
    expect(certain.action).toBe("quarantine");
    expect(certain.drafting).toBe("no_reply");
  });

  it("distrusts an extraction that improvised more than once", () => {
    const d = decide(base({ extraction: complete, droppedFields: ["companyName", "monthlySpend"] }));
    expect(d.action).toBe("escalate_to_human");
  });
});

describe("routing by value, from the directory", () => {
  it("promotes a major opportunity to the founder", () => {
    const d = decide(base({ extraction: complete }));
    expect(d.action).toBe("file_and_notify");
    expect(d.owner).toBe("matt");
    expect(d.reasons).toContain("promoted_to_founder_major_opportunity");
  });

  it("leaves an ordinary inbound enquiry with the growth coordinator", () => {
    const small = ExtractionSchema.parse({
      contactName: f("Sam"),
      companyName: f("Small Cafe"),
      siteLocation: f("Newcastle"),
      monthlySpend: f("$900 per month"),
      tenure: f("lease"),
    });
    const d = decide(base({ extraction: small }));
    expect(d.owner).toBe("zidane");
    expect(d.reasons).toContain("qualification:marginal");
    expect(d.warnings).toContain("premises_leased_roof_rights_not_the_enquirers_to_grant");
  });

  it("treats a missing figure as unmeasured, not as small", () => {
    expect(qualify(ExtractionSchema.parse({})).band).toBe("unknown");
    expect(qualify(ExtractionSchema.parse({ monthlySpend: f("$900 per month") })).band).toBe("marginal");
  });

  it("refuses to assign an engineering question to a non-engineer", () => {
    const d = decide(
      base({
        classification: { intent: "technical_query", confidence: 0.95, rationale: "", evidence: "" },
        extraction: ExtractionSchema.parse({ companyName: f("Solarray"), technicalSubject: f("THD limits") }),
      }),
    );
    expect(d.action).toBe("escalate_to_human");
    expect(d.owner).toBe("unassigned");
    expect(d.reasons).toContain("no_engineering_owner_in_staff_directory");
  });

  it("never replies to a machine", () => {
    const d = decide(
      base({
        classification: { intent: "internal_alert", confidence: 0.95, rationale: "", evidence: "" },
        extraction: ExtractionSchema.parse({ systemName: f("HubSpot"), errorSummary: f("OAuth token expired") }),
      }),
    );
    expect(d.action).toBe("log_no_reply");
    expect(d.drafting).toBe("no_reply");
    expect(d.owner).toBe("ali");
  });
});

describe("duplicates, amendments and conflicts", () => {
  it("does not open a second case for the same enquiry", () => {
    const d = decide(base({ extraction: complete, earlierSibling: { id: "E001", intent: "sales_enquiry" } }));
    expect(d.action).toBe("log_no_reply");
    expect(d.reasons).toContain("duplicate_of:E001");
  });

  it("absorbs a correction into the thread it corrects", () => {
    const d = decide(
      base({
        classification: { intent: "unclear", confidence: 0, rationale: "", evidence: "" },
        isAmendment: true,
        earlierSibling: { id: "E009", intent: "sales_enquiry" },
      }),
    );
    expect(d.intent).toBe("sales_enquiry");
    expect(d.action).toBe("log_no_reply");
    expect(d.reasons).toContain("amendment_to:E009");
  });

  it("still escalates an unclear item that is not a correction", () => {
    const d = decide(
      base({
        classification: { intent: "unclear", confidence: 0, rationale: "", evidence: "" },
        isAmendment: false,
        earlierSibling: { id: "E009", intent: "sales_enquiry" },
      }),
    );
    expect(d.action).toBe("escalate_to_human");
  });

  it("blocks action while two values are unreconciled", () => {
    const d = decide(
      base({
        extraction: complete,
        conflicts: [
          {
            field: "contactPhone",
            values: [
              { value: "0411 999 120", fromItem: "E009", seq: 9, span: "x" },
              { value: "0411 999 102", fromItem: "E010", seq: 10, span: "y" },
            ],
            resolvedTo: null,
            basis: "no statement of which is right",
            autoResolved: false,
          },
        ],
      }),
    );
    expect(d.action).toBe("escalate_to_human");
    expect(d.reasons).toContain("unresolved_conflicts:contactPhone");
  });

  it("escalates when strong matches point at different organisations", () => {
    const d = decide(base({ extraction: complete, crmAmbiguous: true }));
    expect(d.action).toBe("escalate_to_human");
  });
});

describe("completeness", () => {
  it("asks only for what is genuinely missing", () => {
    const partial = ExtractionSchema.parse({
      contactName: f("Sam"),
      siteLocation: f("Newcastle"),
      monthlySpend: f("$80,000 a month"),
    });
    const d = decide(base({ extraction: partial }));
    expect(d.action).toBe("request_missing_info");
    expect(d.missingFields).toEqual(["companyName"]);
    expect(d.drafting).toBe("draft_question");
  });

  it("lets a confidently matched CRM row answer what the message omitted", () => {
    const crmRow: CrmRow = {
      id: "C005",
      company: "Solara Installations",
      contact: "Daniel Wu",
      email: "daniel@solarainstall.example",
      phone: "0400 880 101",
      location: "Sydney NSW",
      stage: "Partner",
      interest: "Installation",
      status: "Active",
    };
    const d = decide(
      base({
        classification: { intent: "partner_operations", confidence: 0.9, rationale: "", evidence: "" },
        extraction: ExtractionSchema.parse({ deadline: f("by Tuesday") }),
        crmRow,
      }),
    );
    expect(d.action).toBe("file_and_notify");
    // The provenance of the borrowed field is recorded, not implied.
    expect(d.reasons.some((r) => r.startsWith("field_from_crm:companyName="))).toBe(true);
  });

  it("escalates rather than asks when there is nowhere to send the question", () => {
    const item = WorkItemSchema.parse({
      id: "T", seq: 1, source: "email", fromName: null, fromEmail: null,
      subject: null, body: "b", attachments: [],
    });
    const d = decide(base({ item }));
    expect(d.action).toBe("escalate_to_human");
    expect(d.reasons).toContain("incomplete_and_uncontactable");
  });
});

describe("money", () => {
  const billing = (over: Partial<GateInput>) =>
    decide(
      base({
        classification: { intent: "billing_dispute", confidence: 0.9, rationale: "", evidence: "" },
        extraction: ExtractionSchema.parse({
          companyName: f("Greenfields Foods"),
          invoiceRef: f("invoice 1847"),
          disputedAmount: f("$2,640"),
        }),
        ...over,
      }),
    );

  it("hands a verified variance above threshold to a person", () => {
    const d = billing({
      reconciliations: [{ kind: "invoice_vs_po", inputs: {}, verdict: "agrees", note: "" }],
    });
    expect(d.action).toBe("escalate_to_human");
    expect(d.reasons).toContain("claim_independently_verified_against_attached_document");
    expect(d.reasons).toContain("variance_above_escalation_threshold:$2,640");
  });

  it("escalates immediately when the documents contradict the claim", () => {
    const d = billing({
      reconciliations: [{ kind: "invoice_vs_po", inputs: {}, verdict: "contradicts", note: "" }],
    });
    expect(d.reasons).toContain("document_arithmetic_contradicts_the_claim");
  });

  it("flags an unverified variance instead of implying it was checked", () => {
    const d = billing({ reconciliations: [] });
    expect(d.warnings).toContain("variance_unverified");
  });
});
