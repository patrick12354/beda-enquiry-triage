import type { Extraction, ExtractionField, GroundedField } from "../domain/schema.js";

/**
 * Groundedness check -- the main anti-hallucination control.
 *
 * The model is asked to return, for every field, the exact span of source text
 * it read the value out of. Here we check that span really occurs in the source.
 * If it does not, the model invented it, and the field is dropped.
 *
 * This turns hallucination from an unbounded failure ("the model made up a
 * budget of $50k and we quoted against it") into a bounded one ("the field came
 * back empty and the gate asked the human"). Empty is recoverable. Confidently
 * wrong is not.
 *
 * The comparison is normalised for whitespace, case and the punctuation that
 * email clients mangle, because we want to catch invention, not typography.
 */

export interface GroundingReport {
  kept: Extraction;
  dropped: Array<{ field: ExtractionField; value: string; span: string; reason: string }>;
}

const SMART_PUNCT = /[‘’‚‛′‵]/g;
const SMART_QUOTES = /[“”„‟″‶]/g;

export function normalise(s: string): string {
  return s
    .replace(SMART_PUNCT, "'")
    .replace(SMART_QUOTES, '"')
    .replace(/[‐-―]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * Fields whose value must ALSO appear in the span, not just the span in the
 * source. Without this a model can quote a real sentence and then attach an
 * invented value to it -- span present, value fabricated.
 */
const VALUE_MUST_APPEAR_IN_SPAN: readonly ExtractionField[] = [
  "email",
  "phone",
  "companyName",
  "companyWebsite",
  "headcount",
  "budget",
];

export function checkGrounding(extraction: Extraction, sourceText: string): GroundingReport {
  const haystack = normalise(sourceText);
  const kept = { ...extraction };
  const dropped: GroundingReport["dropped"] = [];

  for (const [rawField, field] of Object.entries(extraction) as Array<[string, GroundedField | null]>) {
    if (field === null) continue;
    const name = rawField as ExtractionField;
    const span = normalise(field.sourceSpan);
    const value = normalise(field.value);

    if (span.length === 0 || !haystack.includes(span)) {
      dropped.push({ field: name, value: field.value, span: field.sourceSpan, reason: "span_not_in_source" });
      kept[name] = null;
      continue;
    }
    if (VALUE_MUST_APPEAR_IN_SPAN.includes(name) && !span.includes(value)) {
      dropped.push({ field: name, value: field.value, span: field.sourceSpan, reason: "value_not_in_span" });
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
