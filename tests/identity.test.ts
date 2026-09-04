import { describe, expect, it } from "vitest";
import { ExtractionSchema, WorkItemSchema, type CrmRow } from "../src/domain/schema.js";
import {
  findCrmDuplicates,
  matchCrm,
  normaliseCompany,
  normalisePhone,
  resolveConflicts,
  similarity,
} from "../src/pipeline/identity.js";

const CRM: CrmRow[] = [
  { id: "C001", company: "Hume Logistics Pty Ltd", contact: "Amelia Grant", email: "amelia.grant@humelogistics.example", phone: "0400 111 020", location: "Melbourne VIC", stage: "Prospect", interest: "Commercial Solar", status: "Open" },
  { id: "C002", company: "Hume Logistic", contact: "Amelia Grant", email: "a.grant@humelogistics.example", phone: "", location: "Melbourne VIC", stage: "Lead", interest: "Solar", status: "New" },
  { id: "C003", company: "Greenfields Foods Pty Ltd", contact: "Rohan Lee", email: "rohan@greenfieldsfoods.example", phone: "0400 222 310", location: "Geelong VIC", stage: "Client", interest: "Energy Efficiency", status: "Active" },
  { id: "C004", company: "Northbank College", contact: "Melissa Tran", email: "melissa.tran@northbankcollege.example", phone: "0400 330 110", location: "Sydney NSW", stage: "Prospect", interest: "LED", status: "Open" },
  { id: "C005", company: "Solara Installations", contact: "Daniel Wu", email: "daniel@solarainstall.example", phone: "0400 880 101", location: "Sydney NSW", stage: "Partner", interest: "Installation", status: "Active" },
];

const item = (id: string, seq: number, fromEmail: string, body: string) =>
  WorkItemSchema.parse({ id, seq, source: "email", fromName: null, fromEmail, subject: null, body, attachments: [] });

const f = (value: string, sourceSpan = value) => ({ value, sourceSpan, origin: "body", approximate: false });

describe("normalisation", () => {
  it("strips legal suffixes so a plural is the only difference left", () => {
    expect(normaliseCompany("Hume Logistics Pty Ltd")).toBe("hume logistics");
    expect(similarity(normaliseCompany("Hume Logistics Pty Ltd"), normaliseCompany("Hume Logistic"))).toBeGreaterThan(0.9);
  });

  it("keeps transposed digits distinct — the E009/E010 case", () => {
    expect(normalisePhone("0411 999 120")).toBe("+61411999120");
    expect(normalisePhone("0411 999 102")).toBe("+61411999102");
    expect(normalisePhone("0411 999 120")).not.toBe(normalisePhone("0411 999 102"));
  });
});

describe("duplicates inside the CRM export", () => {
  it("finds C001 and C002 and proposes, never applies, a merge", () => {
    const groups = findCrmDuplicates(CRM);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.crmIds.sort()).toEqual(["C001", "C002"]);
    // The survivor is the more complete row, not the lower id.
    expect(groups[0]?.proposedSurvivor).toBe("C001");
    // Fields that differ are held side by side for a person to choose.
    expect(groups[0]?.proposedMerge.stage).toContain("Prospect");
    expect(groups[0]?.proposedMerge.stage).toContain("Lead");
  });

  it("does not merge two genuinely different customers", () => {
    const groups = findCrmDuplicates([CRM[2]!, CRM[3]!, CRM[4]!]);
    expect(groups).toHaveLength(0);
  });
});

describe("matching an item to the CRM", () => {
  it("links on an exact email", () => {
    const { best } = matchCrm(
      item("E003", 3, "rohan@greenfieldsfoods.example", "invoice query"),
      ExtractionSchema.parse({}),
      CRM,
    );
    expect(best?.crmId).toBe("C003");
    expect(best?.signals).toContain("exact_email");
  });

  it("treats the CRM's own duplicate as one organisation, not as ambiguity", () => {
    // Amelia matches C001 and C002. That is the export duplicating itself, and
    // sending every Hume enquiry to a human because of it would be a bug.
    const { ambiguous, matches } = matchCrm(
      item("E001", 1, "amelia.grant@humelogistics.example", "solar"),
      ExtractionSchema.parse({ companyName: f("Hume Logistics Pty Ltd") }),
      CRM,
    );
    expect(matches.filter((m) => m.score >= 0.9).length).toBeGreaterThan(1);
    expect(ambiguous).toBe(false);
  });

  it("does not confuse Solarray with Solara Installations", () => {
    // Similar names, different companies, different domains. A fuzzy matcher
    // that links these files an engineering query against a partner's record.
    const { best } = matchCrm(
      item("E006", 6, "engineering@solarray.example", "harmonics"),
      ExtractionSchema.parse({}),
      CRM,
    );
    expect(best).toBeNull();
  });

  it("does not link on a generic mail domain", () => {
    const { best } = matchCrm(
      item("E007", 7, "priya.dev@examplemail.test", "internship"),
      ExtractionSchema.parse({}),
      CRM,
    );
    expect(best).toBeNull();
  });
});

describe("conflicts within one thread", () => {
  const e009 = {
    item: item("E009", 9, "facilities@harbourcoldstores.example", "Mobile 0411 999 120."),
    extraction: ExtractionSchema.parse({ contactPhone: f("0411 999 120") }),
  };
  const e010 = {
    item: item(
      "E010",
      10,
      "sam@harbourcoldstores.example",
      "Just correcting my number from the web form. It is 0411 999 102, not 0411 999 120.",
    ),
    extraction: ExtractionSchema.parse({ contactPhone: f("0411 999 102") }),
  };

  it("resolves to the corrected value and keeps the superseded one", () => {
    const [c] = resolveConflicts([e009, e010]);
    expect(c?.autoResolved).toBe(true);
    expect(c?.resolvedTo).toBe("0411 999 102");
    expect(c?.values.map((v) => v.value)).toEqual(["0411 999 120", "0411 999 102"]);
  });

  it("refuses to resolve when nobody says which value is right", () => {
    const silent = {
      ...e010,
      item: item("E010", 10, "sam@harbourcoldstores.example", "My number is 0411 999 102."),
    };
    const [c] = resolveConflicts([e009, silent]);
    expect(c?.autoResolved).toBe(false);
    expect(c?.resolvedTo).toBeNull();
    expect(c?.basis).toContain("human must choose");
  });

  it("reports nothing when the thread agrees with itself", () => {
    expect(resolveConflicts([e009, { ...e009, item: item("E009b", 11, "facilities@harbourcoldstores.example", "0411 999 120") }])).toHaveLength(0);
  });
});
