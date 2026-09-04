import type { Decision, Extraction, Reconciliation, WorkItem } from "../domain/schema.js";
import { INTENT_LABELS } from "../domain/taxonomy.js";
import { plainValues } from "./grounding.js";

/**
 * Reply drafting.
 *
 * Deterministic templates, composed from facts the pipeline has already
 * verified. There is a real argument for generating these with a model — the
 * result reads better — and the reason this build does not is narrow: a
 * template cannot state a number that grounding rejected, and a model can. The
 * drafts that go in front of a customer are the last place to reintroduce a
 * failure mode the rest of the system spends its effort removing.
 *
 * Where a model would genuinely help is tone and length on the long tail, and
 * `draftWithModel` in this file is where that would plug in, behind the same
 * approval gate. Nothing about that changes the invariant below.
 *
 * THE INVARIANT: this module returns a string. It has no transport, no address
 * book and no send function, and neither does anything that calls it. The only
 * component in the system that could send is the approval queue's release path,
 * which requires a named human and a specific draft id. A prompt injection that
 * fully compromised the classifier still could not send an email, because there
 * is no code path from here to one.
 */

export interface DraftContext {
  item: WorkItem;
  decision: Decision;
  extraction: Extraction;
  reconciliations: Reconciliation[];
  /** Directory owner, so the draft can name a real person as the follow-up. */
  ownerName: string;
}

export interface Draft {
  subject: string;
  body: string;
  /** Facts the reviewer needs to check the draft without opening three tabs. */
  basis: string[];
}

const SIGNOFF = (owner: string) => `\n\nKind regards,\n${owner}\nBEDA`;

export function draftReply(ctx: DraftContext): Draft | null {
  if (ctx.decision.drafting === "no_reply") return null;

  const v = plainValues(ctx.extraction);
  const who = firstName(v.contactName ?? ctx.item.fromName);
  const hello = who ? `Hi ${who},` : "Hello,";
  const basis: string[] = [];

  // --- a question, because something required is genuinely unknown ----------
  if (ctx.decision.drafting === "draft_question") {
    const asks = ctx.decision.missingFields.map(questionFor).filter(Boolean);
    basis.push(
      `Asks only for the ${ctx.decision.missingFields.length} field(s) the gate marked missing: ${ctx.decision.missingFields.join(", ")}.`,
    );
    if (ctx.decision.warnings.includes("body_claims_an_attachment_but_none_arrived")) {
      asks.push("your portfolio — the message mentions an attachment, but nothing came through");
      basis.push("Mentions the missing attachment rather than ignoring it.");
    }

    return {
      subject: replySubject(ctx.item.subject),
      body:
        `${hello}\n\nThanks for getting in touch with BEDA about ${topic(ctx)}.\n\n` +
        `So we can give you a useful answer rather than a generic one, could you send us:\n\n` +
        asks.map((a) => `  • ${a}`).join("\n") +
        `\n\nOnce we have that, ${ctx.ownerName} will come back to you with next steps.` +
        SIGNOFF(ctx.ownerName),
      basis,
    };
  }

  // --- billing: state what was verified, commit to a date -------------------
  if (ctx.decision.intent === "billing_dispute") {
    const rec = ctx.reconciliations.find((r) => r.kind === "invoice_vs_po");
    const verified = rec?.verdict === "agrees";
    if (verified) {
      basis.push("The variance was recomputed from the attached document, not taken on trust.");
      basis.push(rec!.note);
    } else {
      basis.push("The variance could NOT be verified from the documents supplied; the draft says so.");
    }
    const deadline = v.deadline ? ` You asked for this ${v.deadline}, and we will meet that.` : "";

    return {
      subject: replySubject(ctx.item.subject),
      body:
        `${hello}\n\nThank you for flagging this, and for the detail — it made the check quick.\n\n` +
        (verified
          ? `We have compared ${v.invoiceRef ?? "the invoice"} against the purchase order and we agree there is a variance of ${v.disputedAmount ?? "the amount you quoted"}. ` +
            `We are not asking you to pay the disputed portion while we look into it.\n\n` +
            `${ctx.ownerName} is pulling the line-item detail to identify what accounts for the difference. You will get either an explanation or a credit note.`
          : `We are reconciling ${v.invoiceRef ?? "the invoice"} against the purchase order now. We have not been able to confirm the variance from what we hold, so we may come back to you for a copy of the document your accounts team is working from.\n\n` +
            `Please hold payment of the disputed portion until we have.`) +
        deadline +
        SIGNOFF(ctx.ownerName),
      basis,
    };
  }

  // --- technical: acknowledge, do not answer --------------------------------
  if (ctx.decision.intent === "technical_query") {
    basis.push(
      "Deliberately does NOT answer the technical question. No engineer exists in the staff directory, and a wrong THD answer on a 500 kW battery is a safety matter, not an embarrassment.",
    );
    return {
      subject: replySubject(ctx.item.subject),
      body:
        `${hello}\n\nThanks for the detail on the PCS specification.\n\n` +
        `This needs a qualified engineer to answer properly, so rather than give you a quick reply that you would have to re-check, we are routing it to the right person and will come back to you with a considered answer${v.deadline ? ` ${v.deadline}` : ""}.\n\n` +
        `If the project has a fixed decision date, tell us and we will work to it.` +
        SIGNOFF(ctx.ownerName),
      basis,
    };
  }

  // --- partner operations: answer the actual question -----------------------
  if (ctx.decision.intent === "partner_operations") {
    basis.push("Names the deadline the partner set, so the reply is checkable against it.");
    return {
      subject: replySubject(ctx.item.subject),
      body:
        `${hello}\n\nThanks for holding the crew.\n\n` +
        `We have your request${v.deadline ? ` and your ${v.deadline} deadline` : ""} and ${ctx.ownerName} is confirming the project status internally today. You will have a yes or no in time to release the crew if you need to.\n\n` +
        `We would rather tell you early that it has moved than have you hold a team on a maybe.` +
        SIGNOFF(ctx.ownerName),
      basis,
    };
  }

  if (ctx.decision.intent === "job_application") {
    return {
      subject: replySubject(ctx.item.subject),
      body:
        `${hello}\n\nThank you for your interest in the ${v.roleApplied ?? "role"} at BEDA. We have your application and ${ctx.ownerName} will review it.\n\n` +
        `We will come back to you either way.` +
        SIGNOFF(ctx.ownerName),
      basis,
    };
  }

  // --- sales -----------------------------------------------------------------
  const facts: string[] = [];
  if (v.siteLocation) facts.push(`your ${v.siteLocation} site${v.siteCount ? `s (${v.siteCount})` : ""}`);
  if (v.annualConsumption) facts.push(`${v.annualConsumption} of consumption`);
  else if (v.monthlySpend) facts.push(`${v.monthlySpend} of electricity spend`);
  if (facts.length) basis.push(`Repeats back only grounded facts: ${facts.join("; ")}.`);

  const scope = ctx.reconciliations.find((r) => r.kind === "consumption_scope");
  const askForRest = scope
    ? `\n\nOne practical note: the bill you sent covers a single site for a single month, so before we size anything we will need bills for the other sites. That is the difference between a proposal you can act on and a number we made up.`
    : "";
  if (scope) basis.push("Flags the scope gap found by the document check instead of quoting a sized system.");

  return {
    subject: replySubject(ctx.item.subject),
    body:
      `${hello}\n\nThanks for getting in touch with BEDA about ${topic(ctx)}.\n\n` +
      (facts.length
        ? `We have noted ${facts.join(", ")}. `
        : "") +
      `${ctx.ownerName} will call you to arrange an initial discussion${v.deadline ? ` ${v.deadline}` : " this week"}.` +
      askForRest +
      SIGNOFF(ctx.ownerName),
    basis,
  };
}

function topic(ctx: DraftContext): string {
  const v = plainValues(ctx.extraction);
  if (v.technologies) return v.technologies.toLowerCase();
  return INTENT_LABELS[ctx.decision.intent].toLowerCase();
}

function replySubject(subject: string | null): string {
  if (!subject) return "Re: your enquiry";
  return /^re:/i.test(subject) ? subject : `Re: ${subject}`;
}

function firstName(full: string | null | undefined): string | null {
  if (!full) return null;
  const first = full.trim().split(/\s+/)[0];
  return first && /^[A-Za-z]/.test(first) ? first : null;
}

/**
 * The question text for each required field.
 *
 * Bounded by design: the drafter can only ask for fields the gate marked
 * missing. Left open, a drafting model turns a warm one-line enquiry into a
 * nine-question intake form, which is the fastest way to lose it.
 */
function questionFor(field: string): string {
  const q: Record<string, string> = {
    contactName: "who we should address our reply to",
    companyName: "your company or organisation name",
    siteLocation: "the site address, or at least the suburb",
    consumptionOrSpend:
      "a recent electricity bill, or your annual consumption in kWh — this is the single thing that determines whether an upgrade pays for itself",
    invoiceRef: "the invoice number in question",
    disputedAmount: "the amount you believe is in dispute",
    technicalSubject: "the specific standard or clause you need us to confirm against",
    deadline: "the date you need an answer by",
    roleApplied: "which role you are applying for",
    systemName: "which system raised the alert",
    errorSummary: "the error text",
  };
  return q[field] ?? field;
}
