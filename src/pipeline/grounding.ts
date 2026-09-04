import type { Extraction, ExtractionField, GroundedField, WorkItem } from "../domain/schema.js";
import { sourceTextFor } from "../ingest/load.js";

/**
 * Groundedness check — the main anti-hallucination control.
 *
 * The model must return, for every field, the exact span of source text it read
 * the value out of, and the name of the source it read it from. Here we check
 * that the span really occurs in that source. If it does not, the model
 * invented it, and the field is dropped before it can reach a decision.
 *
 * This converts hallucination from an unbounded failure ("the model reported a
 * $2,640 discrepancy nobody can find and finance paid against it") into a
 * bounded one ("the field came back empty and the gate asked a human"). Empty
 * is recoverable. Confidently wrong is not.
 *
 * Two additions for this dataset:
 *
 *  - Origin checking. A span must appear in the source it CLAIMS to come from.
 *    A model that reads the invoice total off the email body and attributes it
 *    to the attached PO document is wrong in a way that matters, even though
 *    the number happens to be right.
 *
 *  - Numeric containment. For money and energy figures the VALUE must also be
 *    recoverable from the span. Without it a model can quote a real sentence
 *    and hang an invented number on it: span present, value fabricated.
 */

export interface GroundingReport {
  kept: Extraction;
  dropped: Array<{
    field: ExtractionField;
    value: string;
    span: string;
    origin: string;
    reason: string;
  }>;
}

const SMART_SINGLE = /[‘’‚‛′‵]/g;
const SMART_DOUBLE = /[“”„‟″‶]/g;

export function normalise(s: string): string {
  return s
    .replace(SMART_SINGLE, "'")
    .replace(SMART_DOUBLE, '"')
    .replace(/[‐-―]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * Fields where the value itself must be present in the span, not merely the
 * span in the source. These are the fields a wrong number actually costs
 * something: money, energy, counts, contact details.
 */
const VALUE_MUST_APPEAR_IN_SPAN: readonly ExtractionField[] = [
  "contactEmail",
  "contactPhone",
  "companyName",
  "annualConsumption",
  "monthlySpend",
  "peakDemand",
  "fittingCount",
  "invoiceRef",
  "poRef",
  "invoiceAmount",
  "poAmount",
  "disputedAmount",
  "siteCount",
];

/**
 * Compare a value to a span with digits reduced to bare numerals, so that
 * "$2,640" matches "2640" and "2.1 GWh" matches "2.1 gwh". We are trying to
 * catch invention, not punctuation.
 */
function valueIsInSpan(value: string, span: string): boolean {
  if (span.includes(value)) return true;
  const digitsOf = (s: string) => s.replace(/[^0-9.]/g, "");
  const v = digitsOf(value);
  if (v.length >= 2 && digitsOf(span).includes(v)) return true;
  // Number words are how E002 states its consumption ("two gigawatt hours").
  // A model reporting "2" from that span is reading, not inventing.
  const WORDS: Record<string, string> = {
    "0": "zero", "1": "one", "2": "two", "3": "three", "4": "four",
    "5": "five", "6": "six", "7": "seven", "8": "eight", "9": "nine",
  };
  const asWord = WORDS[v];
  return asWord !== undefined && span.includes(asWord);
}

export function checkGrounding(extraction: Extraction, item: WorkItem): GroundingReport {
  const kept = { ...extraction };
  const dropped: GroundingReport["dropped"] = [];

  for (const [rawField, field] of Object.entries(extraction) as Array<
    [string, GroundedField | null]
  >) {
    if (field === null) continue;
    const name = rawField as ExtractionField;
    const origin = field.origin || "body";

    const sourceText = sourceTextFor(item, origin);
    if (sourceText === null) {
      // The model attributed the value to a source that does not exist on this
      // item, or to an attachment the pack never supplied.
      dropped.push({
        field: name,
        value: field.value,
        span: field.sourceSpan,
        origin,
        reason: "unknown_origin",
      });
      kept[name] = null;
      continue;
    }

    const haystack = normalise(sourceText);
    const span = normalise(field.sourceSpan);
    const value = normalise(field.value);

    if (span.length === 0 || !haystack.includes(span)) {
      dropped.push({
        field: name,
        value: field.value,
        span: field.sourceSpan,
        origin,
        reason: "span_not_in_source",
      });
      kept[name] = null;
      continue;
    }

    if (VALUE_MUST_APPEAR_IN_SPAN.includes(name) && !valueIsInSpan(value, span)) {
      dropped.push({
        field: name,
        value: field.value,
        span: field.sourceSpan,
        origin,
        reason: "value_not_in_span",
      });
      kept[name] = null;
      continue;
    }
  }

  return { kept, dropped };
}

/** Flatten to plain values once grounding has passed. */
export function plainValues(e: Extraction): Partial<Record<ExtractionField, string>> {
  const out: Partial<Record<ExtractionField, string>> = {};
  for (const [k, v] of Object.entries(e) as Array<[ExtractionField, GroundedField | null]>) {
    if (v) out[k] = v.value;
  }
  return out;
}

/** Fields the model flagged as its own best reading rather than a stated fact. */
export function approximateFields(e: Extraction): string[] {
  return (Object.entries(e) as Array<[ExtractionField, GroundedField | null]>)
    .filter(([, v]) => v?.approximate)
    .map(([k]) => k);
}
