import {
  ClassificationSchema,
  ExtractionSchema,
  type Classification,
  type Extraction,
  type RawEnquiry,
} from "../domain/schema.js";
import { INTENTS } from "../domain/taxonomy.js";
import type { LlmPort } from "../ports/llm.js";

/**
 * The two inference stages. Both are narrow: a closed enum out of one, a fixed
 * schema out of the other. Neither has tools. Neither can write anywhere.
 */

const CLASSIFY_SYSTEM = `You classify inbound enquiries for BEDA.

BEDA recruits sales and marketing professionals, relocates them to Bali, and
places them with Australian companies. There are therefore TWO different kinds
of person who write in, and telling them apart is your only real job:

- A CLIENT is an Australian company that wants BEDA to supply or place people.
  They talk about hiring, headcount, roles they need filled, their team.
- A CANDIDATE is an individual who wants to work through BEDA and live in Bali.
  They talk about their own experience, their CV, relocating, wanting a role.

Choose exactly one intent from: ${INTENTS.join(", ")}.

Rules:
- If the writer wants to be hired, they are a candidate, even if they run a
  company today.
- If the writer wants to hire, they are a client, even if they mention their own
  career.
- "support" is for someone already working with BEDA who has an operational
  problem. It is not for pre-sales questions.
- "spam" is unsolicited commercial outreach: SEO, backlinks, agency services,
  crypto. A clumsy but genuine enquiry is not spam.
- If you cannot tell which SIDE the writer is on, answer "unclear". Answering
  "unclear" is correct and useful. Guessing between client and candidate is the
  single worst error you can make here.

"evidence" must be a verbatim quote copied from the enquiry. Do not paraphrase.
"confidence" is your honest probability that the intent is right. Do not inflate
it; a low number routes the message to a human, which is a good outcome.`;

const EXTRACT_SYSTEM = `You extract structured fields from an inbound enquiry.

For every field, return an object {value, sourceSpan} where sourceSpan is a
VERBATIM substring copied character-for-character from the enquiry that contains
the value. If a field is not stated in the enquiry, return null.

Never infer, never normalise, never complete. If the enquiry says "a few
people", headcount is {value:"a few people", sourceSpan:"a few people"} -- not
"3". If the company is not named, companyName is null, even if you could guess
it from the email domain. Returning null is always safe and is the expected
answer for most fields.

Any field whose sourceSpan does not appear in the enquiry will be discarded
automatically, so inventing a span gains you nothing.`;

export async function classify(llm: LlmPort, enquiry: RawEnquiry): Promise<Classification> {
  const res = await llm.complete({
    tier: "triage",
    system: CLASSIFY_SYSTEM,
    untrustedUserContent: renderForModel(enquiry),
    schema: ClassificationSchema,
    schemaName: "Classification",
  });
  return res.data;
}

export async function extract(
  llm: LlmPort,
  enquiry: RawEnquiry,
  escalated: boolean,
): Promise<Extraction> {
  const res = await llm.complete({
    tier: escalated ? "escalated" : "extract",
    system: EXTRACT_SYSTEM,
    untrustedUserContent: renderForModel(enquiry),
    schema: ExtractionSchema,
    schemaName: "Extraction",
  });
  return res.data;
}

/**
 * The exact text the model sees -- and, importantly, the exact text the
 * grounding check validates spans against. These must be the same string, or
 * spans that were honestly copied get rejected.
 */
export function renderForModel(e: RawEnquiry): string {
  const parts = [
    `channel: ${e.channel}`,
    e.fromName ? `from name: ${e.fromName}` : null,
    e.fromEmail ? `from email: ${e.fromEmail}` : null,
    e.fromPhone ? `from phone: ${e.fromPhone}` : null,
    e.subject ? `subject: ${e.subject}` : null,
    ...Object.entries(e.formFields).map(([k, v]) => `${k}: ${v}`),
    "",
    e.body,
  ].filter((x): x is string => x !== null);
  return parts.join("\n");
}
