import { describe, expect, it } from "vitest";
import { WorkItemSchema, ExtractionSchema, type WorkItem } from "../src/domain/schema.js";
import { checkGrounding, plainValues } from "../src/pipeline/grounding.js";

/**
 * The grounding check is the anti-hallucination control, so these tests are
 * written from the attacker's side: each one is a specific way a model can
 * return something that looks right and is not.
 */

const item: WorkItem = WorkItemSchema.parse({
  id: "T001",
  seq: 1,
  source: "email",
  fromName: "Amelia Grant",
  fromEmail: "amelia.grant@humelogistics.example",
  subject: "Solar and battery",
  body: "Combined electricity consumption is about 2.1 GWh per year. Please call me on 0400 111 020.",
  attachments: [
    {
      filename: "bill.txt",
      resolved: true,
      text: "Customer: Hume Logistics Pty Ltd\nConsumption: 68,420 kWh\nTotal bill: $18,940",
    },
  ],
});

const field = (value: string, sourceSpan: string, origin = "body", approximate = false) => ({
  value,
  sourceSpan,
  origin,
  approximate,
});

describe("grounding", () => {
  it("keeps a field whose span really appears in the source it names", () => {
    const { kept, dropped } = checkGrounding(
      ExtractionSchema.parse({
        annualConsumption: field("about 2.1 GWh per year", "about 2.1 GWh per year", "body", true),
      }),
      item,
    );
    expect(dropped).toHaveLength(0);
    expect(plainValues(kept).annualConsumption).toBe("about 2.1 GWh per year");
  });

  it("reads an attachment when the field says it came from one", () => {
    const { kept, dropped } = checkGrounding(
      ExtractionSchema.parse({
        companyName: field("Hume Logistics Pty Ltd", "Customer: Hume Logistics Pty Ltd", "bill.txt"),
      }),
      item,
    );
    expect(dropped).toHaveLength(0);
    expect(plainValues(kept).companyName).toBe("Hume Logistics Pty Ltd");
  });

  it("drops a span that appears nowhere — the plainest invention", () => {
    const { kept, dropped } = checkGrounding(
      ExtractionSchema.parse({
        monthlySpend: field("$80,000 a month", "we spend $80,000 a month on power"),
      }),
      item,
    );
    expect(dropped[0]?.reason).toBe("span_not_in_source");
    expect(kept.monthlySpend).toBeNull();
  });

  it("drops a real span attributed to the wrong source", () => {
    // The number is genuine, and it is in the attachment, not the body. A model
    // that misattributes it has told us something false about provenance, and
    // provenance is what the rest of the system reasons with.
    const { kept, dropped } = checkGrounding(
      ExtractionSchema.parse({
        annualConsumption: field("68,420 kWh", "Consumption: 68,420 kWh", "body"),
      }),
      item,
    );
    expect(dropped[0]?.reason).toBe("span_not_in_source");
    expect(kept.annualConsumption).toBeNull();
  });

  it("drops a field naming an attachment this item does not have", () => {
    const { dropped } = checkGrounding(
      ExtractionSchema.parse({
        poAmount: field("$47,300", "Approved value: $47,300", "invoice.txt"),
      }),
      item,
    );
    expect(dropped[0]?.reason).toBe("unknown_origin");
  });

  it("drops a real quote with a fabricated number hung on it", () => {
    // The most dangerous shape: the span is genuine, so a naive substring check
    // passes, and the value is invented.
    const { kept, dropped } = checkGrounding(
      ExtractionSchema.parse({
        contactPhone: field("0400 111 999", "Please call me on 0400 111 020"),
      }),
      item,
    );
    expect(dropped[0]?.reason).toBe("value_not_in_span");
    expect(kept.contactPhone).toBeNull();
  });

  it("tolerates punctuation and formatting differences, not invention", () => {
    const { dropped } = checkGrounding(
      ExtractionSchema.parse({
        peakDemand: field("$18,940", "total bill:   $18,940", "bill.txt"),
      }),
      item,
    );
    expect(dropped).toHaveLength(0);
  });
});
