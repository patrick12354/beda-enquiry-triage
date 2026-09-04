# BEDA — intake, triage and response

Twelve inbound items, three document extracts, a five-row CRM export and a
four-person staff directory go in. Out comes: a category for each item, the
structured facts it contains with the span each one was read from, the
duplicates and contradictions between them, a recommended next action with a
named owner, a drafted reply where a reply is appropriate, and an audit log that
explains every step.

Nothing is sent. Not because a flag says so — because there is no sender.

```bash
npm install
npm test        # 93 tests, no API key, no network
npm run demo    # the whole pack through the whole pipeline, printed
npm run web     # both surfaces on http://localhost:5173
```

On Windows, **double-click [`run-demo.bat`](run-demo.bat)**. It installs on
first run and opens the browser.

| | |
|---|---|
| `/` | **The story.** Six chapters on what this is and why each decision goes the way it does. Chapter V reads the live run and prints the real reason codes. |
| `/inspect` | **The tool.** Every item, its evidence, the CRM matching, the conflicts, the drafts, and the approval queue. |

---

## The one thing worth knowing

**The LLM is a sensor, not an actuator.**

Two model calls exist: one classifies an item into a closed enum, one fills a
fixed schema. Neither has tools, neither can write anywhere, and neither decides
what happens next. Everything downstream — the grounding check, the arithmetic,
the identity resolution, the routing, the action — is deterministic code you can
read, unit test, and diff in a pull request.

The consequence is the second thing worth knowing: **if every model in the
system were fully compromised, zero emails are sent.** The worst reachable
outcome is a wrong label on a draft that a named human still has to approve.

---

## What it does with the supplied pack

| item | category | action | owner | why |
|---|---|---|---|---|
| E001 | Sales enquiry | `file_and_notify` | Matt Cooper | 2.1 GWh/yr clears the major-opportunity threshold |
| E002 | Sales enquiry | `log_no_reply` | Zidane Mouldino | same customer as E001 — one opportunity, one reply |
| E003 | Billing dispute | `escalate_to_human` | Ties Rahardjo | $2,640 variance verified from the document, above the money threshold |
| E004 | Spam | `quarantine` | — | stopped by the pre-filter; never reached a model |
| E005 | Sales enquiry | `request_missing_info` | Zidane Mouldino | no bill, so nothing can be sized; asks for exactly that |
| E006 | Technical query | `escalate_to_human` | **unassigned** | no engineer exists in the directory; the system says so |
| E007 | Job application | `request_missing_info` | Ties Rahardjo | no name given, and the claimed portfolio never arrived |
| E008 | Partner operations | `file_and_notify` | Ties Rahardjo | company name borrowed from CRM C005 rather than asked for |
| E009 | Sales enquiry | `request_missing_info` | Matt Cooper | $80k/month is major; company name genuinely unknown |
| E010 | Sales enquiry | `log_no_reply` | Zidane Mouldino | an amendment to E009 — phone corrected, no second reply |
| E011 | Internal alert | `log_no_reply` | Ali Pratama | a machine wrote it; replying is wrong, not merely unnecessary |
| E012 | Sales enquiry | `request_missing_info` | Zidane Mouldino | marginal, and the roof is the landlord's to grant |

Plus, at the batch level: **MERGE-001**, proposing that CRM rows C001 and C002
are one customer recorded twice — proposed, never applied.

Totals: 12 decided · 8 replies drafted · **0 sent** · **0 CRM rows modified**.

---

## Architecture

```
data/                 the supplied pack, as files
  ├── emails.json     12 items, with `seq` = position in the pack
  ├── crm.csv         5 rows, read-only
  ├── staff.json      4 people — the only source of ownership
  └── documents/      3 extracts, linked to items by filename

ingest      →  four shapes into one WorkItem; attachments kept SEPARATE
prefilter   →  deterministic. junk stopped before a model reads it
classify    →  LLM. closed enum + confidence + verbatim evidence
extract     →  LLM. fixed schema; every value carries a span AND an origin
grounding   →  deterministic. a span that isn't in the source it names is dropped
reconcile   →  deterministic. arithmetic against attached documents
identity    →  deterministic. CRM matching, duplicate detection, conflicts
gate        →  deterministic. THE ONLY PLACE AN ACTION IS CHOSEN
effects     →  stage an internal record (allowed) · draft a reply (never sent)
audit       →  append-only, hash-chained
```

Read [`src/pipeline/gate.ts`](src/pipeline/gate.ts) first. Everything else
exists to give it trustworthy inputs.

### Three decisions I would defend in review

**1. It runs in two passes, not one.**
You cannot know E010 corrects E009 until you have read both, and you cannot know
E002 is a second bite at E001 until E001 is on the table. Any design that
finalises an item the instant it arrives keeps the wrong phone number and quotes
the Hume portfolio twice. In production this is a short holding window rather
than a nightly batch — items are held briefly before their decision commits, and
a correction arriving inside the window amends instead of duplicating.

**2. Category is separate from value.**
A cafe on a leased roof and a logistics group with three warehouses are the same
*category* and wildly different *opportunities*. The model says what an item is;
[`taxonomy.ts`](src/domain/taxonomy.ts) holds the thresholds that say what it is
worth, in numbers a business person can move without touching the pipeline. That
is how E001 reaches the founder and E012 does not, from the same classification.

**3. The CRM is read-only, and that is a safety property.**
E011 reports the sync failing with 146 records unsynchronised. Writing into a
system known to be inconsistent turns a sync failure into a data-loss incident.
So the pipeline stages its own records, proposes merges, and applies none — and
every item processed after that alert carries a warning that its CRM match was
made against data of unknown freshness.

### How uncertainty is preserved

Four mechanisms, because "don't invent facts" has to be enforced, not requested:

- **Span verification.** Every extracted value carries the exact text it was read
  from and the source it was read from. Code checks the span really occurs in
  *that* source. A field that fails is dropped before it can reach a decision —
  hallucination becomes "the field is empty and a human is asked", which is
  recoverable, instead of "confidently wrong", which is not.
- **`approximate` survives.** "about 2.1 GWh", "approximately 1,100 fittings" —
  the hedge is information, and it is carried into the record and shown in the UI
  rather than tidied into a clean-looking number.
- **Three-valued verdicts.** The document checks return `agrees`, `contradicts`
  or `insufficient_data`. "I could not check this" is a real answer; collapsing
  it into "agrees" is how an unverified number acquires the look of verification.
- **`unclear` is terminal, and `unassigned` is a real owner.** The system will
  not guess a category, and it will not invent an engineer.

### Security and permission design

- **The approval queue has no `send`.** It can mark a draft cleared by a named
  person. Transmitting belongs to an outbound service this build does not contain
  and holds no reference to. `requiresHumanApproval: z.literal(true)` — turning it
  off is a type error, not a config change.
- **Approvals must name a human.** Blank approver is rejected; the name goes into
  the audit chain; a draft cannot be decided twice.
- **Untrusted input is fenced and flagged.** Item text is passed to the model in a
  delimited block labelled as data. Instruction-like text ("ignore all previous
  instructions", "send this immediately") is detected, written to the audit log as
  a security event, and *not acted on*. The structural defence is that obeying it
  would achieve nothing: the model has no tools and a closed output schema.
- **Junk never reaches a model.** The most likely carrier of an injection is the
  item nobody wants anyway.
- **Spam requires 0.95 confidence.** A misrouted lead gets noticed; a real
  customer silently binned does not. Quarantine is retained and reversible.
- **No deletes anywhere.** Corrections supersede; superseded values stay in the
  log.

---

## AI tools and models used

**Building it.** Claude (Opus) in Claude Code, used throughout: the pipeline
design, the TypeScript, the tests, the two web surfaces and this README were
written with it, reviewed and corrected by me. The scroll machinery in `site/`
(`scrollcraft.css`, `scrollcraft.js`) is my own from the previous exercise,
reused unchanged; the document content is new.

**Running it.** Everything goes through [OpenRouter](https://openrouter.ai), so a
model is a config string in [`src/config/models.ts`](src/config/models.ts) rather
than an SDK dependency:

| tier | model | in / out per 1M | used for |
|---|---|---|---|
| triage | `deepseek/deepseek-v4-flash-0731` | $0.065 / $0.18 | classify every item that survives the pre-filter |
| extract | `deepseek/deepseek-v4-flash-0731` | $0.065 / $0.18 | structured extraction |
| escalated | `deepseek/deepseek-v4-pro-0813` | $1.12 / $3.35 | low confidence, sales, and billing — where being wrong costs money |
| draft | `deepseek/deepseek-v4-pro-0813` | $1.12 / $3.35 | **configured, not wired** — see weaknesses |

The chain is single-vendor by choice. A DeepSeek-wide outage takes out every
tier at once, and the system degrades to a human queue on a *tighter* one-hour
SLA rather than to a wrong answer. Cross-vendor cover is one line per chain in
that file and no other change anywhere.

**Default is no model at all.** With no `OPENROUTER_API_KEY`, classification and
extraction run on a deterministic keyword-and-regex stand-in
([`heuristic-llm.ts`](src/ports/heuristic-llm.ts)), labelled "simulated"
everywhere it surfaces. That is not a shortcut — it is how the port boundary gets
tested. If the pipeline produces the same decisions against regex as against a
hosted model, the pipeline genuinely does not depend on the model, which is the
claim the architecture makes.

---

## Known weaknesses

Honest list. Each of these is a real limitation of what is in the repository.

1. **The offline stand-in is not a model.** It nails these twelve items because
   its regexes were written against this domain. On genuinely novel phrasing it
   will return `unclear` far more often than a real model would — which is safe,
   and is also not the same thing as being good. **The decision logic is what I
   am claiming works; the extraction quality is a stand-in.**
2. **Drafts are templates.** Deliberate — a template cannot state a number that
   grounding rejected — but they will read stiff on the long tail. The right fix
   is a drafting model constrained to only reference verified fields, behind the
   same approval gate. The tier is already configured for it.
3. **Batch, not streaming.** The two-pass design is correct for this problem and
   the holding window is described above, not built. As written, an item arriving
   after the run finishes gets no retrospective conflict resolution.
4. **Entity clustering is O(n²) and re-runs per item.** Fine for twelve, wrong
   for twelve thousand. It needs an incremental index.
5. **All state is in memory.** Restarting the server re-runs the pack from
   scratch. Approvals do not survive a restart.
6. **The reconciliation module knows two shapes** — invoice-versus-PO and
   consumption scope. A third document type gets no arithmetic check at all,
   silently. It should say "no check applies" rather than say nothing.
7. **Conflict resolution has exactly one auto-resolve rule** (an explicit later
   correction). Everything else goes to a human. That is the safe default and it
   will feel heavy-handed at volume — E001/E002 raise five conflicts that a person
   would resolve in about four seconds.
8. **`renderForModel` and the grounding source text are two functions that must
   agree.** They do, and there is no test that will fail loudly if a future edit
   makes them diverge. Every honest span would start being rejected.
9. **No labelled evaluation set.** I assert the twelve decisions are right; I have
   not measured accuracy on anything I did not also design against.
10. **The staff directory is trusted implicitly.** It is the one input treated as
    authoritative rather than untrusted, which is defensible for an internal file
    and is still an assumption written nowhere but here.

## With another day

In this order:

1. **A labelled eval set** — 60–80 items with expected category, owner and
   action, including deliberate adversarial and near-miss cases, so a prompt or
   threshold change produces a number instead of an opinion. This is first
   because without it every other improvement is guesswork.
2. **Persistence** — SQLite behind the existing ports. The interfaces are already
   shaped for it; approvals surviving a restart is the difference between a demo
   and something a person can leave open.
3. **The drafting model, properly constrained** — allowed to reference only
   grounded fields, with a post-check that every number in the draft appears in
   the verified extraction. Same approval gate.
4. **The holding window** — replace the batch with a real short-delay commit, so
   the E009/E010 behaviour works on a live mailbox and not only on a fixed pack.
5. **A one-screen conflict resolver** — the five Hume conflicts as five
   side-by-side choices with a keyboard shortcut, because the safe default is
   only tolerable if resolving is fast.
6. **A shared-span test** between `renderForModel` and `sourceTextFor`, closing
   weakness 8.

---

## Layout

| path | what it is |
|---|---|
| [`src/pipeline/gate.ts`](src/pipeline/gate.ts) | the decision engine — read this first |
| [`src/domain/taxonomy.ts`](src/domain/taxonomy.ts) | categories, owners, thresholds, reply policy |
| [`src/pipeline/grounding.ts`](src/pipeline/grounding.ts) | span verification — the anti-hallucination control |
| [`src/pipeline/identity.ts`](src/pipeline/identity.ts) | CRM matching, duplicates, conflict resolution |
| [`src/pipeline/reconcile.ts`](src/pipeline/reconcile.ts) | arithmetic against attached documents |
| [`src/pipeline/run.ts`](src/pipeline/run.ts) | orchestrator — a linear state machine, not an agent |
| [`src/pipeline/draft.ts`](src/pipeline/draft.ts) | reply composition; returns a string, has no transport |
| [`src/ports/records.ts`](src/ports/records.ts) | the approval boundary — note the absent `send` |
| [`src/ports/audit.ts`](src/ports/audit.ts) | append-only, hash-chained log |
| [`src/ports/heuristic-llm.ts`](src/ports/heuristic-llm.ts) | the offline stand-in |
| [`src/ingest/load.ts`](src/ingest/load.ts) | four sources into one shape |
| [`web/`](web) · [`site/`](site) | the inspector, and the story |
| [`docs/DESIGN.md`](docs/DESIGN.md) | longer form: the arguments behind the choices |

All data in this repository is the supplied synthetic pack. No real BEDA records
appear anywhere.
