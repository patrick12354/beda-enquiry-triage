# Design notes

Longer form than the README. This is the argument behind each choice, including
the ones I am least sure about.

---

## 1. What the problem actually is

The brief reads like a classification problem. It is not, quite. Classifying
these twelve items is the easy part — most of them announce what they are in the
subject line. The hard parts are the three the brief buries:

- Two items are the same customer, and one of them is a *correction* rather than
  a duplicate. Getting those the same way is wrong twice over.
- One item makes a numeric claim that the attachment can verify, and one makes a
  numeric claim the attachment *cannot* verify but looks like it can.
- One item asks for expertise that does not exist inside the organisation, and
  the staff directory is small enough that any of four names could be made to
  sound plausible.

Everything structural in this build follows from those three, so it is worth
saying plainly: **the system is designed around not being confidently wrong, not
around being accurate.** Those are different targets and they produce different
architectures. A system optimised for accuracy tries to answer every item. This
one tries to make every answer either verifiable or explicitly absent.

---

## 2. The taxonomy, and why value is not a category

Eight categories: `sales_enquiry`, `billing_dispute`, `technical_query`,
`partner_operations`, `internal_alert`, `job_application`, `spam`, `unclear`.

The temptation is nine, splitting sales into qualified and unqualified. I did not,
and the reason generalises.

"This is a sales enquiry" is a question about the *text*. "This enquiry deserves
the founder's time" is a question about *thresholds the business owns*. Putting
both inside one label hides a business decision inside a model output, where it
cannot be tuned by the person who cares about it and cannot be tested. So the
model answers the first question and [`gate.ts`](../src/pipeline/gate.ts) answers
the second, using numbers that live in
[`taxonomy.ts`](../src/domain/taxonomy.ts):

```ts
majorAnnualKwh: 500_000,
majorMonthlySpendAud: 20_000,
marginalMonthlySpendAud: 2_000,
```

E001 and E012 are both `sales_enquiry`. One reaches Matt because 2.1 GWh clears
the first threshold; the other stays with Zidane and carries two warnings. Moving
the boundary between them is editing one number, and nothing about the
classification changes.

There is a fourth band that matters as much as the three thresholds: **`unknown`
is not `marginal`.** An enquiry with no stated figure is unmeasured, not small.
It gets asked, not demoted. E005 is the case — Northbank has 1,100 fittings and
no bill, and the temptation to treat "no numbers" as "low value" would lose a
whole campus.

## 3. The routing table

Every route quotes the directory line that justifies it, and the interesting
routes are the ones where the directory is ambiguous or silent.

**Sales splits on value, not topic.** The directory gives Matt "major commercial
opportunities" and Zidane "inbound growth enquiries". Those overlap unless
"major" means something, so it does — see above. Inbound is Zidane's by default
and promotes to Matt on threshold.

**E002 is the interesting routing conflict.** It arrives through the website,
which is Zidane's, and it is a solar opportunity, which is Matt's. The rule I
settled on: *the channel owner is informed, the intent owner is accountable.*
Ownership is singular; awareness is not, which is why `RouteRule` has both
`owner` and `consult`.

**E006 has no owner and the system says so.** The directory has no engineer, and
E006 asks in terms for "your engineer" to confirm THD limits at the point of
common coupling on a 500 kW battery. The owner is `unassigned`, the reason code
is `no_engineering_owner_in_staff_directory`, and Matt is consulted for the
decision *who should answer this*, not for the answer. The drafted reply
deliberately does not answer the question.

This is the single decision I would most want to be asked about, because the
alternative is so tempting. Assigning it to Ali (systems), or to Matt (founder,
therefore responsible for everything) would have looked tidier in the output
table and would have quietly assigned a safety-adjacent electrical question to
someone unqualified to answer it. **A gap that is visible is a gap someone can
fix. A gap that has been papered over is a liability.**

**E011 gets a ticket, not a conversation.** Reply policy is per-category
(`reply_expected` / `reply_if_contactable` / `never_reply`) and lives in the
taxonomy rather than in the drafting model's discretion. Two items must never be
answered and the reasons differ: replying to E004 confirms a live mailbox to a
list vendor, and replying to E011 is how an alert channel becomes noise people
stop reading.

---

## 4. Three duplicate problems

| | what it is | what the system does |
|---|---|---|
| C001 / C002 | one customer, twice, inside the CRM export | scans the export against itself, raises `MERGE-001`, **applies nothing** |
| E001 / E002 | one customer writing twice, two addresses, two spellings | links by email domain; answers once, logs the second |
| E009 / E010 | one person correcting themself | recognised as an *amendment*; supersedes, amends the staged record, no second reply |

The third is the one a naive design gets wrong. Treated as a duplicate, E010 is
discarded and the system keeps `0411 999 120` — a number that is wrong by a
two-digit transposition, which is exactly the kind of wrong that survives a
casual eyeball.

Detecting it needs two signals together: the item is in a known thread, and its
text announces itself as a correction ("Just correcting my number… It is
0411 999 102, not 0411 999 120"). Recency alone is not enough — the most recent
message is not automatically the most correct one, and a rule that says otherwise
will eventually let a typo overwrite a verified field.

### Why there is no model in any of this

Asking an LLM "are these the same company?" is non-reproducible, unauditable, and
worse at the job than normalisation plus a similarity score. `Hume Logistics Pty
Ltd` and `Hume Logistic` normalise to strings with a Dice coefficient of 0.96,
and I can show you the number. When a merge is wrong, two customers' histories
are welded together and separating them is manual, so the threshold for acting
automatically is high and the threshold for *proposing* is low.

### The ambiguity trap

An early version escalated every Hume item to a human with
`ambiguous_crm_match`, because Amelia matched both C001 and C002 strongly and the
code counted distinct company names. That is the CRM's own duplication
resurfacing as pipeline noise. Ambiguity is when strong matches point at
organisations that are *not plausibly the same one* — so the check now compares
the matches to each other rather than counting them.

The opposite error is guarded by a test: `solarray.example` (E006) must not match
`Solara Installations` (C005). Similar names, different domains, different
companies. A fuzzy matcher tuned loose enough to merge Hume will also merge these
two if nothing stops it, and the result would file an engineering query against a
delivery partner's record.

---

## 5. Arithmetic is not inference

E003 claims invoice 1847 is $2,640 above the PO. The attachment holds
$49,940 and $47,300. The check is deterministic code, and the reason is narrow:
a model asked to verify this will usually get it right and will occasionally,
quietly, get it wrong, and the output is heading for a finance conversation.
**Subtraction is the one part of the pipeline that should never be
probabilistic.**

Worth recording that my first version of this check was wrong in exactly the way
the whole design is built to catch. It read `Purchase order: GF PO 8821`, took
the reference number as a dollar value, computed a $41,119 variance, and reported
that the customer's arithmetic was wrong. Every part of that output looked like
arithmetic. The fix is one line — a money figure must carry a currency symbol —
and the lesson is that the dangerous failure is never the obviously-mad number.
It is the plausible one nobody questions, and it is why the reconciliation inputs
are shown in the UI with the source line beside each figure.

The second check does not resolve anything, on purpose. E001 says 2.1 GWh a year
across three warehouses; the attachment is 68,420 kWh for one site for July.
Both true, not the same fact, and a system that files 68,420 kWh as this
customer's consumption has lost an order of magnitude of opportunity. So the
check states the scope mismatch, does the extrapolation once, labels it
*arithmetic, not a measurement*, and asks for the other two bills.

---

## 6. Failure modes, and what happens in each

| failure | behaviour | why that way |
|---|---|---|
| every model in the chain is down | all items → `escalate_to_human` with a **1-hour** SLA | a degraded system must be more responsive, not less; nothing is being handled |
| the model returns unparseable JSON | one repair attempt showing it its own error, then the next model in the chain | two repairs is latency for no gain |
| the model invents a value | grounding drops the field; two or more drops escalates the whole item | one dropped field is noise, several means it was improvising |
| the model is prompt-injected | flagged in the audit log, not obeyed | it has no tools and a closed schema; obeying achieves nothing |
| an attachment is referenced but missing | `resolved: false`, warning raised, no check attempted | never an empty string that downstream code reads as "the document said nothing" |
| the body claims an attachment and none arrived | warning, and the drafted question mentions it | the applicant believes they sent something |
| the CRM sync is broken | every subsequent match warned, batch-level warning, still read-only | the alert is in the pack; ignoring it would be the actual failure |
| an item is replayed | idempotent on item id; no second record, no second draft | webhook redelivery is the most common duplicate in production |
| a CRM row is malformed | reported as an ingest issue, not padded | a shifted column puts a phone number in the location field |

---

## 7. Cost

At the tiering in [`models.ts`](../src/config/models.ts), and assuming the
observed shape of this pack — roughly one item in twelve stopped free by the
pre-filter, and the rest costing one triage call plus one extraction call, with
the stronger model on sales and billing — 1,000 items a month runs at
**roughly $1.45**, against about $5.30 if every call ran on the Pro tier.

I want to be straight about this: **cost is not the binding constraint here, and
the tiering is not really a cost decision.** At BEDA's volume the difference is
lunch. The tiering exists because it makes "which model, for what" an explicit,
editable line rather than an accident, and because it puts the stronger model
exactly where being wrong costs money. The saving is a side effect worth
measuring, not the argument.

---

## 8. The approval boundary

The invariant, stated three ways because it is the point of the build:

**In the type system.** `requiresHumanApproval: z.literal(true)`. Not a boolean.
Turning it off is a compile error, not a config change.

**In the structure.** [`draft.ts`](../src/pipeline/draft.ts) returns a string. It
has no transport, no address book and no send function, and neither does anything
that calls it. `ApprovalQueuePort` has `enqueue`, `approve`, `reject`, `list` —
and no `send`. Releasing a draft belongs to an outbound service this build does
not contain and holds no reference to.

**In the tests.** `expect(queue.send).toBeUndefined()`, and an end-to-end
assertion that a fully prompt-injected item still produces zero sends and a draft
awaiting approval.

Approval requires a named human, is rejected if the name is blank, cannot be
applied twice, and writes the approver's name into the hash-chained audit log.

The same instinct produced the read-only CRM. Given an alert saying 146 records
are unsynchronised, the choice is between writing into a system known to be
inconsistent and staging changes for a human with the sync fixed. Only one of
those is reversible.

---

## 9. The change surface

Where to edit when a requirement moves. This is written down because a design
you cannot change on request is not a design.

| if the requirement becomes… | change |
|---|---|
| different owners, or a fifth person | `STAFF` and `ROUTING` in `taxonomy.ts` |
| a new category | add to `INTENTS`, add a `ROUTING` entry, a `REQUIRED_FIELDS` line, a `CONFIDENCE_FLOOR`, and a branch in the classifier prompt |
| "major" means something else | three numbers in `SALES_ROUTING` |
| money escalates at a different figure | `BILLING_ESCALATION_AUD` in `gate.ts` |
| a category must never be auto-replied | its `responsePolicy` in `taxonomy.ts` |
| a different model, or cross-vendor fallback | `MODELS` and `FALLBACKS` in `config/models.ts` — one line per chain, no other change |
| a new document type needs checking | a new function in `reconcile.ts` and a `kind` in the schema |
| the CRM becomes writable | `RecordStorePort` gains an apply method; nothing in the pipeline changes, because the pipeline only ever calls `stage` |
| recency alone should resolve conflicts | `CORRECTION_MARKERS` / `resolveConflicts` in `identity.ts` — and I would argue against it |
| items arrive continuously | replace `runBatch`'s loop with the holding window described in the README; the two-pass structure is already the right shape |

---

## 10. What I am least sure about

- **The confidence floors are guesses.** 0.7 for most, 0.95 for spam. They are
  the right *shape* — spam strictly highest, because a binned customer is silent
  — and the specific numbers have no evidence behind them. A labelled eval set
  is the first thing I would build with more time, and it exists to replace these
  numbers with measured ones.
- **Unresolved conflicts blocking the whole item may be too strict.** E001/E002
  disagree about five fields, none of which prevent someone phoning Amelia. A
  more careful design would block only the fields the *action* depends on. I
  chose the blunt version because it fails safe and because I would rather explain
  a system that asked too often than one that acted on a coin flip.
- **Two-pass batching is right for this pack and is not a general answer.** The
  holding window is described, not built, and its correct duration is a business
  question I have no data for.
- **E007's routing is arguable.** A marketing internship is Zidane's function and
  hiring admin is Ties's. I gave it to Ties and put Zidane in `consult`. Reversing
  it would be defensible; what would not be defensible is not noticing there is a
  choice.
