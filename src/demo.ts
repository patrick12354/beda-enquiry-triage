import { ingest } from "./ingest/load.js";
import { runBatch, type RunDeps } from "./pipeline/run.js";
import { InMemoryAudit } from "./ports/audit.js";
import { HeuristicLlm } from "./ports/heuristic-llm.js";
import { InMemoryApprovalQueue, InMemoryRecordStore } from "./ports/records.js";
import { INTENT_LABELS } from "./domain/taxonomy.js";

/**
 * `npm run demo` — the whole supplied pack through the whole pipeline, printed.
 *
 * Runs offline against the deterministic stand-in, so it needs no API key and
 * no network. The point is that every line below is reproducible: run it twice
 * and diff the output.
 */

const { items, crm, issues } = await ingest();

const records = new InMemoryRecordStore();
const audit = new InMemoryAudit();
const approvals = new InMemoryApprovalQueue(audit);
const deps: RunDeps = { llm: new HeuristicLlm(), crm, records, approvals, audit };

const result = await runBatch(items, deps);

const pad = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n));
const rule = (n = 108) => console.log("─".repeat(n));

console.log("\nBEDA — intake, triage and response");
console.log(`${items.length} items · ${crm.length} CRM rows · simulated inference, no network\n`);

if (issues.length) {
  console.log("Ingest notes");
  rule();
  for (const i of issues) console.log(`  · ${i}`);
  console.log();
}

console.log("Decisions");
rule();
console.log(pad("item", 6) + pad("category", 20) + pad("action", 22) + pad("owner", 18) + "reply");
rule();
for (const o of result.outcomes) {
  console.log(
    pad(o.item.id, 6) +
      pad(INTENT_LABELS[o.decision.intent], 20) +
      pad(o.decision.action, 22) +
      pad(o.decision.ownerName, 18) +
      (o.draft ? `drafted ${o.draft.draftId}` : "none"),
  );
  for (const r of o.decision.reasons) console.log(`        · ${r}`);
  for (const w of o.decision.warnings) console.log(`        ! ${w}`);
}

console.log("\nDuplicates and identity");
rule();
for (const d of result.crmDuplicates) {
  console.log(`  ${d.proposalId}  ${d.crmIds.join(" + ")}  (${d.reason})  — proposed, NOT applied`);
}
for (const e of result.entities.filter((x) => x.itemIds.length > 1 || x.crmIds.length > 1)) {
  console.log(`  ${e.entityId}  ${e.displayName}`);
  console.log(`        items: ${e.itemIds.join(", ")}${e.crmIds.length ? `   crm: ${e.crmIds.join(", ")}` : "   crm: none — new organisation"}`);
  console.log(`        via:   ${e.signals.join(", ")}`);
  for (const c of e.conflicts) {
    console.log(
      `        conflict on ${c.field}: ${c.values.map((v) => `${v.value} (${v.fromItem})`).join("  vs  ")}`,
    );
    console.log(`             ${c.autoResolved ? `resolved → ${c.resolvedTo}` : "UNRESOLVED — held for a human"}`);
    console.log(`             ${c.basis}`);
  }
}

console.log("\nDocument checks");
rule();
for (const o of result.outcomes) {
  for (const r of o.reconciliations) {
    console.log(`  ${o.item.id}  ${r.kind}  → ${r.verdict}`);
    console.log(`        ${r.note}`);
  }
}

if (result.batchWarnings.length) {
  console.log("\nRun-level warnings");
  rule();
  for (const w of result.batchWarnings) console.log(`  ! ${w}`);
}

console.log("\nSide effects");
rule();
console.log(`  Records staged                  : ${result.stats.recordsStaged}`);
console.log(`  CRM rows modified               : 0   (read-only by design — see ports/records.ts)`);
console.log(`  Merge proposals raised          : ${result.crmDuplicates.length}`);
console.log(`  Merge proposals applied         : 0`);
console.log(`  Replies drafted                 : ${result.stats.draftsQueued}`);
console.log(`  Replies awaiting human approval : ${approvals.list().filter((d) => d.status === "awaiting_approval").length}`);
console.log(`  Replies actually sent           : ${result.stats.draftsSent}   ← by construction, not by luck`);
console.log(`  Inference calls                 : ${result.stats.inferenceCalls} (${result.stats.prefiltered} item(s) never reached a model)`);

console.log("\nAudit trail — E003 (the invoice dispute)");
rule();
for (const e of await audit.forItem("E003")) {
  console.log(`  #${String(e.seq).padStart(3)}  ${pad(e.stage, 16)} ${pad(e.actor, 18)} ${e.summary}`);
}
const v = await audit.verify();
console.log(`\n  hash chain intact: ${v.ok}${v.ok ? "" : ` (broken at #${v.brokenAtSeq})`}\n`);
