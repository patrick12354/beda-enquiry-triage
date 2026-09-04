import { describe, expect, it } from "vitest";
import { WorkItemSchema } from "../src/domain/schema.js";
import { parseEnergyKwh, parseMoney, reconcile } from "../src/pipeline/reconcile.js";

const withDoc = (body: string, filename: string, text: string, resolved = true) =>
  WorkItemSchema.parse({
    id: "T",
    seq: 1,
    source: "email",
    fromName: null,
    fromEmail: "a@b.example",
    subject: null,
    body,
    attachments: [{ filename, text, resolved }],
  });

const GREENFIELDS = `Greenfields Foods
Purchase order: GF PO 8821
Approved value: $47,300 ex GST
Invoice 1847: $49,940 ex GST
Project: Geelong LED upgrade`;

const HUME_BILL = `Customer: Hume Logistics Pty Ltd
Site: Truganina Distribution Centre
Billing period: 1 July to 31 July 2026
Consumption: 68,420 kWh
Maximum demand: 172 kW
Total bill: $18,940`;

describe("money and energy parsing", () => {
  it("prefers a $-prefixed amount over a bare number on the same line", () => {
    // This is the bug that made the first build tell a customer they were wrong.
    expect(parseMoney("Invoice 1847: $49,940 ex GST")).toBe(49940);
  });

  it("normalises energy units to kWh", () => {
    expect(parseEnergyKwh("about 2.1 GWh per year")).toBe(2_100_000);
    expect(parseEnergyKwh("Consumption: 68,420 kWh")).toBe(68420);
    expect(parseEnergyKwh("820 MWh")).toBe(820_000);
  });

  it("returns null rather than guessing when there is no figure", () => {
    expect(parseEnergyKwh("around two gigawatt hours annually")).toBeNull();
  });
});

describe("invoice against purchase order", () => {
  it("verifies the customer's stated variance from the document", () => {
    const [r] = reconcile(
      withDoc(
        "our accounts team says invoice 1847 is $2,640 higher than the purchase order",
        "03.txt",
        GREENFIELDS,
      ),
    );
    expect(r?.verdict).toBe("agrees");
    expect(r?.inputs.computedVariance).toBe("$2,640");
  });

  it("does not read the PO reference number as the PO value", () => {
    const [r] = reconcile(withDoc("invoice 1847 is $2,640 higher", "03.txt", GREENFIELDS));
    expect(r?.inputs.purchaseOrder).toContain("$47,300");
    expect(r?.inputs.purchaseOrder).not.toContain("8,821");
  });

  it("reports a contradiction rather than silently preferring one figure", () => {
    const [r] = reconcile(withDoc("invoice 1847 is $5,000 higher", "03.txt", GREENFIELDS));
    expect(r?.verdict).toBe("contradicts");
    expect(r?.note).toContain("$2,640");
    expect(r?.note).toContain("$5,000");
  });

  it("says insufficient_data when the message states no figure to check", () => {
    const [r] = reconcile(withDoc("please reconcile invoice 1847", "03.txt", GREENFIELDS));
    expect(r?.verdict).toBe("insufficient_data");
  });

  it("says insufficient_data when the attachment was never supplied", () => {
    const [r] = reconcile(withDoc("invoice 1847 is $2,640 higher", "03.txt", "", false));
    expect(r?.verdict).toBe("insufficient_data");
    expect(r?.note).toContain("not supplied");
  });
});

describe("consumption scope", () => {
  it("refuses to resolve a portfolio figure against a single-site bill", () => {
    const rs = reconcile(
      withDoc(
        "Combined electricity consumption is about 2.1 GWh per year across three sites.",
        "01.txt",
        HUME_BILL,
      ),
    );
    const scope = rs.find((r) => r.kind === "consumption_scope");
    expect(scope?.verdict).toBe("insufficient_data");
    // The extrapolation is offered, and labelled as arithmetic rather than fact.
    expect(scope?.inputs.singleSiteAnnualised).toContain("arithmetic, not a measurement");
    expect(scope?.note).toContain("neither replaces the other");
  });
});
