import { describe, expect, it } from "vitest";
import { parseCsv, parseCsvRecords } from "../src/ingest/csv.js";

describe("csv", () => {
  it("distinguishes an empty field from a malformed row", () => {
    // C002 in the supplied export has no phone. That is a legitimate empty
    // value, and a parser that pads or shifts columns would silently move the
    // location into the phone field.
    const { records, errors } = parseCsvRecords(
      "id,company,phone,location\nC002,Hume Logistic,,Melbourne VIC\n",
    );
    expect(errors).toHaveLength(0);
    expect(records[0]).toEqual({ id: "C002", company: "Hume Logistic", phone: "", location: "Melbourne VIC" });
  });

  it("reports a short row instead of guessing at it", () => {
    const { records, errors } = parseCsvRecords("a,b,c\n1,2\n4,5,6\n");
    expect(records).toHaveLength(1);
    expect(errors[0]?.reason).toContain("expected 3 columns");
  });

  it("handles quoted commas and escaped quotes", () => {
    expect(parseCsv('a,b\n"Grant, Amelia","she said ""yes"""\n')).toEqual([
      ["a", "b"],
      ["Grant, Amelia", 'she said "yes"'],
    ]);
  });

  it("does not emit a phantom row for a trailing newline", () => {
    expect(parseCsv("a,b\n1,2\n")).toHaveLength(2);
  });

  it("refuses a file that ends inside a quoted field", () => {
    expect(() => parseCsv('a,b\n"unterminated,2\n')).toThrow(/quoted field/);
  });
});
