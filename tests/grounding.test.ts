import { describe, expect, it } from "vitest";
import { checkGrounding, normalise, plainValues } from "../src/pipeline/grounding.js";
import type { Extraction } from "../src/domain/schema.js";

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

const SOURCE = `Hi team,

We're North Shore Digital and we want to put on 2 appointment setters.
Reach me at marcus@northshoredigital.com.au.`;

describe("grounding", () => {
  it("keeps a field whose span really appears in the source", () => {
    const { kept, dropped } = checkGrounding(
      { ...EMPTY, companyName: { value: "North Shore Digital", sourceSpan: "We're North Shore Digital" } },
      SOURCE,
    );
    expect(dropped).toHaveLength(0);
    expect(plainValues(kept).companyName).toBe("North Shore Digital");
  });

  it("drops an invented value even when it sounds plausible", () => {
    const { kept, dropped } = checkGrounding(
      { ...EMPTY, budget: { value: "AUD 50,000", sourceSpan: "our budget is AUD 50,000" } },
      SOURCE,
    );
    expect(dropped[0]?.reason).toBe("span_not_in_source");
    expect(kept.budget).toBeNull();
  });

  it("drops a real quote that has a fabricated value bolted onto it", () => {
    // The nastiest failure mode: the span is genuine, so a naive check passes,
    // but the value was never in the text.
    const { kept, dropped } = checkGrounding(
      { ...EMPTY, headcount: { value: "20", sourceSpan: "put on 2 appointment setters" } },
      SOURCE,
    );
    expect(dropped[0]?.reason).toBe("value_not_in_span");
    expect(kept.headcount).toBeNull();
  });

  it("does not punish a model for whitespace or smart quotes", () => {
    const { dropped } = checkGrounding(
      { ...EMPTY, companyName: { value: "North Shore Digital", sourceSpan: "We’re   North Shore Digital" } },
      SOURCE,
    );
    expect(dropped).toHaveLength(0);
  });

  it("normalises punctuation the way mail clients mangle it", () => {
    expect(normalise("We’re  “ok” — fine")).toBe('we\'re "ok" - fine');
  });
});
