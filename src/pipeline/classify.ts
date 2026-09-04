import {
  ClassificationSchema,
  ExtractionSchema,
  type Classification,
  type Extraction,
  type WorkItem,
} from "../domain/schema.js";
import { INTENTS } from "../domain/taxonomy.js";
import { renderForModel } from "../ingest/load.js";
import type { LlmPort } from "../ports/llm.js";

/**
 * The two inference stages, and the only two places a model is used.
 *
 * Both are deliberately narrow. One returns a value from a closed enum; the
 * other fills a fixed schema. Neither has tools, neither can write anywhere,
 * and neither chooses what happens next. Everything downstream of here treats
 * their output as a claim to be verified, not as a result.
 */

const CLASSIFY_SYSTEM = `You classify inbound items for BEDA, an Australian commercial energy business.

BEDA sells and delivers commercial solar, battery storage, LED lighting upgrades
and energy efficiency work to businesses and institutions.

Choose exactly one intent from: ${INTENTS.join(", ")}.

  sales_enquiry       Someone outside BEDA wants energy work: solar, battery, LED,
                      efficiency, a proposal, a quote, a site assessment. This is
                      the category regardless of how large or small the
                      opportunity looks. Do not downgrade a small enquiry to
                      "unclear" because you doubt it is worth doing — size is not
                      your decision and is assessed elsewhere.

  billing_dispute     An existing customer queries money already invoiced: an
                      invoice that does not match a purchase order, a variance, a
                      request to reconcile before payment.

  technical_query     An engineering question that needs a qualified engineer:
                      harmonics, THD, protection settings, grid connection,
                      inverter or PCS specification, standards compliance.

  partner_operations  A delivery partner or subcontractor coordinating crews,
                      site access, install dates, logistics or scheduling.

  internal_alert      A machine reporting to BEDA: a monitoring alert, a failed
                      job, a sync error, an expired token. No human wrote it.

  job_application     A person asking to work at BEDA: an application, a CV, a
                      portfolio, an internship request.

  spam                Unsolicited commercial outreach: bought lead lists, SEO,
                      crypto payment requests, cold vendor pitches.

  unclear             A real item you cannot confidently place. This is a correct
                      and useful answer. Choosing it sends the item to a person,
                      which is always safe. Guessing is not.

"evidence" must be a verbatim quote copied from the item. Do not paraphrase.
"confidence" is your honest probability that the intent is right. Do not inflate
it. A low number routes the item to a human, which is a good outcome, and the
system is built to expect it.`;

const EXTRACT_SYSTEM = `You extract structured fields from an inbound item for BEDA.

For every field, return {value, sourceSpan, origin, approximate} or null.

  sourceSpan   A VERBATIM substring, copied character for character from the
               item, that contains the value. Not a paraphrase.
  origin       "body" if you read it from the message itself, or the exact
               attachment filename if you read it from an attachment.
  approximate  true when the source itself is imprecise — "about 2.1 GWh",
               "around two gigawatt hours", "approximately 1,100 fittings". The
               hedge is information and must survive into the record.

Rules, in order of importance:

1. Never infer, never normalise, never convert, never complete. If the item says
   "around two gigawatt hours annually", annualConsumption is
   {value:"around two gigawatt hours", ...} with approximate true. It is not
   "2000000 kWh". Unit conversion is arithmetic and is done downstream by code.

2. If a field is not stated in the item, return null. Returning null is always
   safe and is the expected answer for most fields on most items. Do not guess a
   company name from an email domain. Do not assume a location from an area code.

3. Attribute correctly. If the invoice total appears only in an attached
   document, origin is that filename, not "body". A value read from the wrong
   source is treated as invented, even when the number is right.

4. Any field whose sourceSpan does not appear in the source you named will be
   discarded automatically by code that runs after you. Inventing a span gains
   you nothing and loses the field.`;

export async function classify(llm: LlmPort, item: WorkItem): Promise<Classification> {
  const res = await llm.complete({
    tier: "triage",
    system: CLASSIFY_SYSTEM,
    untrustedUserContent: renderForModel(item),
    schema: ClassificationSchema,
    schemaName: "Classification",
  });
  return res.data;
}

export async function extract(
  llm: LlmPort,
  item: WorkItem,
  escalated: boolean,
): Promise<Extraction> {
  const res = await llm.complete({
    tier: escalated ? "escalated" : "extract",
    system: EXTRACT_SYSTEM,
    untrustedUserContent: renderForModel(item),
    schema: ExtractionSchema,
    schemaName: "Extraction",
  });
  return res.data;
}

export { renderForModel };
