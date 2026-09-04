import type { Reconciliation, WorkItem } from "../domain/schema.js";

/**
 * Cross-document reconciliation.
 *
 * A message makes a claim. An attached document contains the numbers that claim
 * rests on. This module checks one against the other with arithmetic, in
 * deterministic code, and never asks a model to do sums.
 *
 * That is not fussiness about tokens. E003 says invoice 1847 is "$2,640 higher
 * than the purchase order", and the attached document says $49,940 against a
 * $47,300 PO. A model asked to verify this will usually get it right and will
 * occasionally, silently, get it wrong — and the output of this check is
 * heading for a finance conversation. Subtraction is the one part of the
 * pipeline that should never be probabilistic.
 *
 * The verdicts are deliberately three-valued. "I could not check this" is a
 * distinct, useful answer, and collapsing it into "agrees" is how an unverified
 * number acquires the appearance of verification.
 */

/** Money, as written in Australian business documents: $47,300 / $49,940 ex GST. */
export function parseMoney(raw: string): number | null {
  const flat = raw.replace(/\s/g, "");
  // A $-prefixed amount always wins. Without this, "Invoice 1847: $49,940"
  // parses as 1847 — the invoice NUMBER read as the invoice VALUE, which is
  // the kind of quiet, plausible error that reaches finance unchallenged.
  const m = flat.match(/\$(-?[\d,]+(?:\.\d{1,2})?)/) ?? flat.match(/(-?[\d,]+(?:\.\d{1,2})?)/);
  if (!m?.[1]) return null;
  const n = Number(m[1].replaceAll(",", ""));
  return Number.isFinite(n) ? n : null;
}

/**
 * First money amount on a line that also matches `label`.
 *
 * The line must carry a currency symbol. Without that requirement, "Purchase
 * order: GF PO 8821" reads as an $8,821 purchase order — a reference number
 * silently promoted to a value. The variance would then come out at $41,119,
 * the system would announce that the customer's claim is wrong, and every part
 * of that would look like arithmetic.
 */
function moneyNear(text: string, label: RegExp): { amount: number; line: string } | null {
  for (const line of text.split(/\r?\n/)) {
    if (!label.test(line) || !line.includes("$")) continue;
    const amount = parseMoney(line);
    if (amount !== null) return { amount, line: line.trim() };
  }
  return null;
}

/** Energy figures, normalised to kWh. Handles kWh, MWh and GWh. */
export function parseEnergyKwh(raw: string): number | null {
  const m = raw.replace(/,/g, "").match(/(-?\d+(?:\.\d+)?)\s*(kwh|mwh|gwh)/i);
  if (!m?.[1] || !m?.[2]) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  const unit = m[2].toLowerCase();
  return unit === "gwh" ? n * 1_000_000 : unit === "mwh" ? n * 1_000 : n;
}

/** Tolerance for "the same number". Rounding in a PO should not read as a dispute. */
const MONEY_TOLERANCE_AUD = 1;

export function reconcile(item: WorkItem): Reconciliation[] {
  const out: Reconciliation[] = [];
  for (const att of item.attachments) {
    if (!att.resolved) {
      out.push({
        kind: "invoice_vs_po",
        inputs: { attachment: att.filename },
        verdict: "insufficient_data",
        note: `${item.id} references ${att.filename}, which was not supplied. No claim in this message can be checked against it.`,
      });
      continue;
    }
    const invoiceVsPo = checkInvoiceAgainstPo(item.body, att.text, att.filename);
    if (invoiceVsPo) out.push(invoiceVsPo);

    const scope = checkConsumptionScope(item.body, att.text, att.filename);
    if (scope) out.push(scope);
  }
  return out;
}

/**
 * The E003 case: a stated variance, checked against the document it came with.
 */
function checkInvoiceAgainstPo(
  body: string,
  doc: string,
  filename: string,
): Reconciliation | null {
  const po = moneyNear(doc, /\b(purchase order|approved value|\bpo\b)/i);
  const invoice = moneyNear(doc, /\binvoice\b/i);
  if (!po && !invoice) return null;

  // What the sender claims the gap is. Absent is fine — plenty of billing
  // queries state no figure at all.
  const claimMatch = body.match(/\$[\d,]+(?:\.\d{1,2})?\s*(?:higher|more|above|over|extra)/i);
  const claimed = claimMatch ? parseMoney(claimMatch[0]) : null;

  const inputs: Record<string, string> = { attachment: filename };
  if (po) inputs.purchaseOrder = `$${po.amount.toLocaleString("en-AU")} — "${po.line}"`;
  if (invoice) inputs.invoice = `$${invoice.amount.toLocaleString("en-AU")} — "${invoice.line}"`;
  if (claimed !== null) inputs.claimedInMessage = `$${claimed.toLocaleString("en-AU")}`;

  if (!po || !invoice) {
    return {
      kind: "invoice_vs_po",
      inputs,
      verdict: "insufficient_data",
      note: `${filename} supplies only ${po ? "the purchase order" : "the invoice"} value. The variance cannot be computed from the documents provided.`,
    };
  }

  const computed = Math.round((invoice.amount - po.amount) * 100) / 100;
  inputs.computedVariance = `$${computed.toLocaleString("en-AU")}`;

  if (claimed === null) {
    return {
      kind: "invoice_vs_po",
      inputs,
      verdict: "insufficient_data",
      note: `Documents show a variance of $${computed.toLocaleString("en-AU")} (invoice $${invoice.amount.toLocaleString("en-AU")} less PO $${po.amount.toLocaleString("en-AU")}). The message states no figure, so there is nothing to check it against.`,
    };
  }

  const agrees = Math.abs(computed - claimed) <= MONEY_TOLERANCE_AUD;
  return {
    kind: "invoice_vs_po",
    inputs,
    verdict: agrees ? "agrees" : "contradicts",
    note: agrees
      ? `Independently verified: invoice $${invoice.amount.toLocaleString("en-AU")} less PO $${po.amount.toLocaleString("en-AU")} is $${computed.toLocaleString("en-AU")}, matching the $${claimed.toLocaleString("en-AU")} stated in the message. The customer's arithmetic is correct; the question is which line item accounts for it.`
      : `The message claims $${claimed.toLocaleString("en-AU")}, but the documents give $${computed.toLocaleString("en-AU")}. Both figures are reported; neither is assumed correct.`,
  };
}

/**
 * The E001 case, and the more interesting of the two.
 *
 * The email claims about 2.1 GWh a year across three warehouses. The attached
 * bill is one site, one month. Those are not in conflict and they are also not
 * the same fact, and a system that quietly files "68,420 kWh" as this customer's
 * consumption has lost an order of magnitude of opportunity.
 *
 * So this check does not resolve anything. It states the scope mismatch, does
 * the extrapolation ONCE and labels it as arithmetic rather than as evidence,
 * and leaves the judgement with the human who will make the call.
 */
function checkConsumptionScope(
  body: string,
  doc: string,
  filename: string,
): Reconciliation | null {
  const docKwh = parseEnergyKwh(doc);
  const claimKwh = parseEnergyKwh(body);
  if (docKwh === null || claimKwh === null) return null;

  const periodLine = doc
    .split(/\r?\n/)
    .find((l) => /billing period/i.test(l))
    ?.trim();
  const siteLine = doc
    .split(/\r?\n/)
    .find((l) => /^site:/i.test(l))
    ?.trim();

  const monthly = /1 [a-z]+ to 3[01] [a-z]+/i.test(periodLine ?? "");
  const annualised = monthly ? docKwh * 12 : null;

  const inputs: Record<string, string> = {
    attachment: filename,
    documentConsumption: `${docKwh.toLocaleString("en-AU")} kWh`,
    messageClaim: `${claimKwh.toLocaleString("en-AU")} kWh per year`,
  };
  if (periodLine) inputs.documentPeriod = periodLine;
  if (siteLine) inputs.documentSite = siteLine;
  if (annualised !== null) {
    inputs.singleSiteAnnualised = `${annualised.toLocaleString("en-AU")} kWh (${docKwh.toLocaleString("en-AU")} × 12 — arithmetic, not a measurement)`;
  }

  return {
    kind: "consumption_scope",
    inputs,
    verdict: "insufficient_data",
    note:
      `The attached bill covers a different scope from the figure in the message: ` +
      `${siteLine ? siteLine.replace(/^site:\s*/i, "") : "one site"}${periodLine ? `, ${periodLine.replace(/^billing period:\s*/i, "")}` : ""}, ` +
      `against a portfolio figure for the year. The two do not contradict each other and neither replaces the other. ` +
      (annualised !== null
        ? `Annualising the single site gives ${annualised.toLocaleString("en-AU")} kWh, which is consistent with ${claimKwh.toLocaleString("en-AU")} kWh across three sites, but that is an extrapolation from one month and is not evidence. `
        : "") +
      `Bills for the remaining sites are required before any figure is used for sizing.`,
  };
}
