# BEDA — enquiry intake, triage and response

A design and a working reference slice for a system that ingests BEDA's inbound
enquiries, works out what each one is, extracts structured information, asks for
what is missing, files the right record, drafts the next response, alerts the
right person, and keeps an audit trail that holds up.

**→ The design document is [`docs/DESIGN.md`](docs/DESIGN.md).** Start there.
This README covers the code.

**Double-click [`run-demo.bat`](run-demo.bat)**. It installs dependencies on
first run, needs no API key, and opens `http://localhost:5173`, which serves two
surfaces of the same piece:

| | |
|---|---|
| `/` | **The document.** A scroll-driven read of the design in six chapters. Chapter V runs the real decision rules in the page, and you can rewrite the enquiry and watch it decide again. |
| `/demo` | **The tool.** Push any of the ten sample enquiries, or your own, through the actual pipeline. |

Or from a terminal:

```bash
npm install
npm test        # 32 tests, no API key needed
npm run web     # both surfaces on localhost:5173
npm run demo    # the same pipeline, printed to the terminal
```

The tool shows which of the eleven stages ran, the gate's decision and its named
reasons, what was written to the CRM, and the draft waiting in the approval queue
beside a counter that reads **0 sent**. State persists between submissions, so
sending the same enquiry twice is how you watch deduplication work.

---

## The one thing worth knowing

BEDA is two-sided: it recruits sales and marketing talent in Bali and places
them with Australian companies. So an enquiry is either from a **client** who
wants to hire or a **candidate** who wants to be hired, and those go to
different systems, different owners and different privacy regimes.

The expensive failure is not misjudging a lead. It is **crossing the two sides**.
The taxonomy, the routing table and the gate are all built around not doing that.

The second thing: **the LLM is a sensor, not an actuator.** It classifies,
extracts and drafts. Every decision and every write is deterministic code.

---

## Pipeline

```
RawEnquiry
  → prefilter        deterministic   honeypot, blocklist, link flood  (~35% dropped, 0 tokens)
  → classify         LLM tier 1      intent + confidence + evidence
  → extract          LLM tier 2      fields, each with a verbatim source span
  → checkGrounding   deterministic   discard any field whose span isn't in the source
  → resolveIdentity  deterministic   message id → email/phone → fuzzy (never auto-merges)
  → decide           deterministic   THE GATE — the only place an action is chosen
  → effects                          CRM write (allowed) · draft (queued for approval, never sent)
  → audit                            append-only, hash-chained
```

## Layout

| Path | What it is |
|---|---|
| [`src/domain/taxonomy.ts`](src/domain/taxonomy.ts) | Intents, routing table, required fields per intent |
| [`src/domain/schema.ts`](src/domain/schema.ts) | Zod schemas. `requiresHumanApproval: z.literal(true)` lives here |
| [`src/pipeline/gate.ts`](src/pipeline/gate.ts) | **The decision engine.** Read this one first |
| [`src/pipeline/grounding.ts`](src/pipeline/grounding.ts) | Span verification — the anti-hallucination control |
| [`src/pipeline/dedupe.ts`](src/pipeline/dedupe.ts) | Identity resolution and normalisation |
| [`src/pipeline/classify.ts`](src/pipeline/classify.ts) | The two prompts, and the exact text the model sees |
| [`src/pipeline/run.ts`](src/pipeline/run.ts) | Orchestrator — a linear state machine, not an agent |
| [`src/config/models.ts`](src/config/models.ts) | Model tiering, fallback chains, spend caps |
| [`src/ports/`](src/ports/) | LLM (OpenRouter + scripted + simulated), CRM, approval queue, audit |
| [`src/server.ts`](src/server.ts) | Serves both surfaces and the API — node:http, zero extra deps |
| [`site/`](site/) · [`web/`](web/) | The document, and the clickable tool |
| [`src/fixtures/enquiries.ts`](src/fixtures/enquiries.ts) | Ten enquiries covering every branch, incl. a prompt injection |

## Two invariants the code enforces

**Nothing is ever sent.** The pipeline holds no reference to an outbound sender.
It can only enqueue for approval. A bug or a successful injection cannot send an
email because there is no code path to one.

```ts
requiresHumanApproval: z.literal(true)   // not a boolean — a compile error to disable
```

**Nothing unverified is ever filed.** Every extracted field carries the verbatim
span it came from, and deterministic code checks that span exists in the source
before the value reaches a decision.

```
source:  "we want to put on 2 appointment setters"
model:   headcount = { value: "20", sourceSpan: "put on 2 appointment setters" }
         → span is real, value is not → DROPPED
```

## Model tiering

Everything goes through **OpenRouter**, so a model is config rather than a
dependency. Prices are live rates per 1M tokens, recorded in
[`src/config/models.ts`](src/config/models.ts).

| Tier | Model | in | out |
|---|---|---|---|
| triage, extract | `deepseek/deepseek-v4-flash-0731` | $0.065 | $0.18 |
| escalated, draft | `deepseek/deepseek-v4-pro-0813` | $1.12 | $3.35 |

About **$1.39/month** at 1,000 enquiries, against $3.42 if everything ran on Pro.
The chain is single-vendor by choice — a DeepSeek-wide outage degrades to a human
triage queue on a *tighter* SLA rather than to a wrong answer. See
[`docs/DESIGN.md` §6](docs/DESIGN.md) for the arithmetic, and for why cost is not
the binding constraint here.

## Running against real models

Set `OPENROUTER_API_KEY` (see [`.env.example`](.env.example)) and `/demo`
switches from the simulated stand-in to real DeepSeek calls automatically — the
bar says which brain is in use. Tests always stay on the scripted adapter so they
remain deterministic.

## Scope

This is the triage core, deliberately. Not included: the outbound sender, the
Slack approval UI, a labelled eval set, ATS integration, multi-language handling.
[`docs/DESIGN.md` §9](docs/DESIGN.md) covers what that leaves open and where I
expect the design to be wrong.
