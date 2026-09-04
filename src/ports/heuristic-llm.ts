import { z } from "zod";
import { MODELS } from "../config/models.js";
import type { LlmPort, LlmRequest, LlmResult, OutputSchema } from "./llm.js";

/**
 * A deterministic stand-in for the two inference calls, so the whole system
 * runs with no API key, no network and no cost.
 *
 * This is not a model and does not pretend to be one. It is weighted keyword
 * scoring and regex, and it is labelled "simulated" everywhere it surfaces. It
 * exists for two reasons.
 *
 * First, the interesting part of this system is what happens AFTER inference —
 * grounding, reconciliation, identity resolution, the gate, the approval
 * boundary — and none of that should require a credit card to demonstrate or a
 * network round trip to test.
 *
 * Second, it is an honest test of the port boundary. If the pipeline produces
 * the same decisions against regex as against a hosted model, then the pipeline
 * genuinely does not depend on the model, which is the central claim the
 * architecture makes. Swapping the brain is a constructor argument.
 *
 * Every span it emits is a real substring of the source it names, so
 * extractions pass the grounding check honestly rather than by exemption. Where
 * it is unsure it returns null and lets the gate ask a human, which is the same
 * behaviour the real prompts are written to produce.
 */

const SALES: Array<[RegExp, number]> = [
  [/\b(solar|photovoltaic|\bpv\b|battery|batteries|energy storage)\b/i, 2],
  [/\b(led|lighting upgrade|fluorescent|fittings?)\b/i, 1.8],
  [/\b(energy efficiency|reduce (operating )?cost|cost reduction|electricity (bill|cost|spend))\b/i, 1.8],
  [/\b(proposal|quote|quotation|pricing|initial discussion|site assessment|feasibility)\b/i, 2],
  [/\b(we (operate|run|have|lease|own)|our (sites?|warehouses?|campus|premises|facility))\b/i, 1.5],
  [/\b(gwh|mwh|kwh|consumption|maximum demand)\b/i, 1.5],
  [/\b(incentives?|rebates?|government (support|funding))\b/i, 1.2],
];

const BILLING: Array<[RegExp, number]> = [
  [/\binvoice\b[^.]{0,40}\b(does not match|doesn't match|higher|discrepan|variance|query)\b/i, 4],
  [/\b(purchase order|\bpo\b)\b/i, 2],
  [/\b(accounts? (team|payable)|reconcil|before payment|credit note)\b/i, 2.5],
  [/\b(overcharg|short paid|underpaid|billed twice)\b/i, 3],
];

const TECHNICAL: Array<[RegExp, number]> = [
  [/\b(thd|harmonics?|total harmonic distortion)\b/i, 4],
  [/\b(point of common coupling|\bpcc\b|grid connection|protection settings?|fault level)\b/i, 3],
  [/\b(pcs|inverter) (specification|spec|design)\b/i, 3],
  [/\b(as\/nzs|as ?4777|standard \d+|compliance study|harmonic study)\b/i, 2.5],
  [/\b(your|an) engineer\b/i, 2],
];

const PARTNER_OPS: Array<[RegExp, number]> = [
  [/\b(crew|installers?|team of \w+|four person|scaffold)\b/i, 3],
  [/\b(availability|hold (a|the)|book|schedule|site access|week (beginning|commencing))\b/i, 2.5],
  [/\b(confirm(ation)? by|proceeding|go ahead|mobilis|mobiliz)\b/i, 2],
];

const INTERNAL_ALERT: Array<[RegExp, number]> = [
  [/\b(sync|job|cron|pipeline|backup|integration) (job )?(failed|failure|error)\b/i, 4],
  [/\b(oauth|token|api key)\b[^.]{0,20}\b(expired|invalid|revoked)\b/i, 4],
  [/\b(retry disabled|unsynchronis|unsynchroniz|alert|monitoring|error:)\b/i, 2.5],
  [/^alerts?@/i, 3],
];

const JOB: Array<[RegExp, number]> = [
  [/\b(apply|application|internship|graduate program|vacancy|position)\b/i, 3],
  [/\b(my (cv|resume|portfolio)|attached (cv|resume|portfolio))\b/i, 3],
  [/\bwould love to (apply|join|work)\b/i, 3],
];

const SPAM: Array<[RegExp, number]> = [
  [/\b(crypto|bitcoin|cryptocurrency)\b/i, 4],
  [/\b(buy|purchase)\b[^.]{0,40}\bleads?\b/i, 4],
  [/\b(seo|backlinks?|domain authority|guest post)\b/i, 4],
  [/\b(price expires|act now|limited time offer)\b/i, 2],
];

function score(text: string, signals: Array<[RegExp, number]>): number {
  return signals.reduce((acc, [re, w]) => acc + (re.test(text) ? w : 0), 0);
}

/**
 * Confidence from the margin between the top two candidates, not from the top
 * score alone. An item that scores 6 on sales and 5.5 on billing is genuinely
 * ambiguous no matter how high either number is, and should reach a human.
 */
function confidenceFrom(top: number, second: number): number {
  if (top <= 0) return 0;
  const margin = (top - second) / top;
  return Math.max(0.3, Math.min(0.96, 0.55 + margin * 0.45));
}

/** First capture group of the first matching pattern, as a real substring. */
function firstMatch(text: string, patterns: RegExp[]): string | null {
  for (const re of patterns) {
    const m = text.match(re);
    if (m) return (m[1] ?? m[0]).trim();
    }
  return null;
}

interface Sources {
  body: string;
  attachments: Array<{ name: string; text: string }>;
}

/**
 * Recover the labelled sources back out of the rendered prompt text.
 *
 * The stand-in receives exactly what a real model would receive, so it has to
 * do the same work of telling body from attachment. Keeping it honest here is
 * what makes the origin field meaningful rather than decorative.
 */
function splitSources(rendered: string): Sources {
  const parts = rendered.split(/\n--- attachment: (.+?)(?: \(referenced but not supplied\))? ---\n?/);
  const body = parts[0] ?? "";
  const attachments: Array<{ name: string; text: string }> = [];
  for (let i = 1; i < parts.length; i += 2) {
    const name = parts[i];
    const text = parts[i + 1];
    if (name !== undefined) attachments.push({ name, text: text ?? "" });
  }
  return { body, attachments };
}

type Field = { value: string; sourceSpan: string; origin: string; approximate: boolean } | null;

/** Find a value across body and attachments, reporting where it was actually read. */
function seek(
  sources: Sources,
  patterns: RegExp[],
  opts: { approximate?: RegExp; preferAttachment?: boolean } = {},
): Field {
  const order = opts.preferAttachment
    ? [...sources.attachments.map((a) => ({ origin: a.name, text: a.text })), { origin: "body", text: sources.body }]
    : [{ origin: "body", text: sources.body }, ...sources.attachments.map((a) => ({ origin: a.name, text: a.text }))];

  for (const src of order) {
    const hit = firstMatch(src.text, patterns);
    if (hit) {
      return {
        value: hit,
        sourceSpan: hit,
        origin: src.origin,
        approximate: opts.approximate ? opts.approximate.test(hit) : false,
      };
    }
  }
  return null;
}

const HEDGE = /\b(about|around|approximately|approx|roughly|circa|~)\b/i;

export type LlmMode = "live" | "simulated";

export function describeMode(mode: LlmMode): string {
  return mode === "live"
    ? `live — ${MODELS.triage.id} / ${MODELS.escalated.id} via OpenRouter`
    : "simulated — deterministic keyword and regex stand-in, no network, no cost";
}

export class HeuristicLlm implements LlmPort {
  async complete<T>(req: LlmRequest & { schema: OutputSchema<T> }): Promise<LlmResult<T>> {
    const sources = splitSources(req.untrustedUserContent);
    const data =
      req.schemaName === "Classification"
        ? this.classify(req.untrustedUserContent)
        : this.extract(sources);

    return {
      data: (req.schema as z.ZodTypeAny).parse(data) as T,
      modelUsed: "simulated/heuristic",
      usdSpent: 0,
      latencyMs: 1,
      attempts: 1,
    };
  }

  private classify(text: string) {
    const scored: Array<{ intent: string; n: number }> = [
      { intent: "spam", n: score(text, SPAM) },
      { intent: "internal_alert", n: score(text, INTERNAL_ALERT) },
      { intent: "billing_dispute", n: score(text, BILLING) },
      { intent: "technical_query", n: score(text, TECHNICAL) },
      { intent: "partner_operations", n: score(text, PARTNER_OPS) },
      { intent: "job_application", n: score(text, JOB) },
      { intent: "sales_enquiry", n: score(text, SALES) },
    ].sort((a, b) => b.n - a.n);

    const top = scored[0]!;
    const second = scored[1]!;

    // Nothing scored: say so. "unclear" routes to a person, which is correct
    // for an item this stand-in genuinely cannot read.
    if (top.n < 2) {
      return {
        intent: "unclear",
        confidence: 0,
        rationale: "No category scored above the minimum signal threshold.",
        evidence: text.slice(0, 120),
      };
    }

    return {
      intent: top.intent,
      confidence: confidenceFrom(top.n, second.n),
      rationale: `Scored ${top.n.toFixed(1)} on ${top.intent}, next best ${second.intent} at ${second.n.toFixed(1)}.`,
      evidence: firstEvidence(text, top.intent) ?? text.slice(0, 120),
    };
  }

  private extract(s: Sources) {
    return {
      contactName: seek(s, [
        /^from name:\s*(.+)$/im,
        /\bI am the facilities manager,\s*([A-Z][a-z]+)/,
        /\bContact\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\b/,
        /^Account contact:\s*(.+)$/im,
      ]),
      contactEmail: seek(s, [/^from email:\s*(\S+@\S+)$/im, /\b([\w.+-]+@[\w-]+\.[\w.]+)\b/]),
      contactPhone: seek(s, [
        /\b(?:It is|Mobile|call me on|number|phone)\D{0,12}(0\d{3}\s?\d{3}\s?\d{3})\b/i,
        /\b(0\d{3}\s?\d{3}\s?\d{3})\b/,
      ]),
      // Company names are read from where they are STATED. Never inferred from
      // an email domain — that is the rule the real prompt states, and the
      // stand-in has to obey it or the demo lies about the system's behaviour.
      companyName: seek(
        s,
        [
          // Stop at a sentence boundary. E002 states its company inline —
          // "Company: Hume Logistic. We have three distribution sites…" — and a
          // greedy match swallows the whole paragraph as the company name.
          /^Customer:\s*([^.\n]+)/im,
          /^Company:\s*([^.\n]+)/im,
          /\bfacilities at\s+([A-Z][\w&.'-]*(?:\s+[A-Z][\w&.'-]*)*)/,
          /^([A-Z][\w&.'-]*(?:\s+[A-Z][\w&.'-]*)*)\s*$/m,
        ],
        { preferAttachment: true },
      ),
      siteLocation: seek(s, [
        /\bwarehouses? in\s+([A-Z][\w-]+(?:,\s*[A-Z][\w-]+)*(?:\s+and\s+[A-Z][\w-]+)?)/,
        /\b(?:warehouse|cafe|site|campus|premises|project) (?:in|at)\s+([A-Z][\w-]+)/,
        /\bsites? in\s+([A-Z][\w-]+)/,
      ]),
      siteCount: seek(s, [/\b(three|two|four|five|\d+)\s+(?:distribution\s+)?(?:sites?|warehouses?|locations?)\b/i]),

      annualConsumption: seek(
        s,
        [
          /((?:about|around|approximately)?\s*[\d.]+\s*(?:GWh|MWh|kWh)(?:\s*per year|\s*annually)?)/i,
          /((?:about|around|approximately)\s+\w+\s+gigawatt hours(?:\s*annually)?)/i,
        ],
        { approximate: HEDGE },
      ),
      monthlySpend: seek(
        s,
        [
          /((?:about|around|approximately)?\s*\$[\d,]+(?:\.\d\d)?\s*(?:a|per)\s*month)/i,
          /(\$[\d,]+(?:\.\d\d)?\s*(?:a|per)\s*month)/i,
        ],
        { approximate: HEDGE },
      ),
      peakDemand: seek(s, [/^Maximum demand:\s*(.+)$/im, /\b([\d,]+\s*kW)\b(?!h)/]),
      fittingCount: seek(
        s,
        [/((?:approximately|about|around)?\s*[\d,]+\s*(?:fluorescent\s*)?fittings)/i],
        { approximate: HEDGE },
      ),
      technologies: seek(s, [
        /\b(solar,?(?:\s*possibly)?\s*batteries?(?:\s*and\s*lighting upgrades?)?)/i,
        /\b(LED upgrade|lighting upgrade|commercial solar|solar proposal|battery|solar)\b/i,
      ]),
      tenure: seek(s, [/\b(lease|leased|leasing|rent|rented|tenant|owner-occupied|we own)\b/i]),

      invoiceRef: seek(s, [/\b(invoice\s*#?\s*\d+)\b/i]),
      poRef: seek(s, [/^Purchase order:\s*(.+)$/im, /\b(PO\s*\d+)\b/i], { preferAttachment: true }),
      invoiceAmount: seek(s, [/^Invoice \d+:\s*(\$[\d,]+(?:\.\d\d)?)/im], { preferAttachment: true }),
      poAmount: seek(s, [/^Approved value:\s*(\$[\d,]+(?:\.\d\d)?)/im], { preferAttachment: true }),
      disputedAmount: seek(s, [/(\$[\d,]+(?:\.\d\d)?)\s*(?:higher|more|above|over|extra)/i]),

      deadline: seek(s, [
        /\b((?:before|by)\s+(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|\d{1,2}\s+\w+))\b/i,
        /\b(week (?:beginning|commencing)\s+\d{1,2}\s+\w+)\b/i,
      ]),
      technicalSubject: seek(s, [
        /\b(acceptable THD limits[^.?]*)/i,
        /\b((?:THD|harmonic|protection|grid connection|PCS)[^.?]{0,80})/i,
      ]),
      systemName: seek(s, [/\b(HubSpot|Salesforce|Pipedrive|Xero|MYOB|SharePoint)\b/i]),
      errorSummary: seek(s, [/Error:\s*([^\n.]+)/i, /\b((?:OAuth )?token expired)\b/i]),
      roleApplied: seek(s, [/\b(?:apply for (?:your|the|a)?\s*)([\w\s]*intern(?:ship)?)\b/i, /\b(marketing internship|internship)\b/i]),
    };
  }
}

/** A verbatim quote that supports the chosen intent, for the reviewer to read. */
function firstEvidence(text: string, intent: string): string | null {
  const map: Record<string, Array<[RegExp, number]>> = {
    spam: SPAM,
    internal_alert: INTERNAL_ALERT,
    billing_dispute: BILLING,
    technical_query: TECHNICAL,
    partner_operations: PARTNER_OPS,
    job_application: JOB,
    sales_enquiry: SALES,
  };
  for (const [re] of map[intent] ?? []) {
    const m = text.match(re);
    if (m?.[0]) return m[0].slice(0, 200);
  }
  return null;
}
