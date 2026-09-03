import { ALL_FIXTURES, scriptMap } from "./fixtures/enquiries.js";
import { processEnquiry, type RunDeps } from "./pipeline/run.js";
import { InMemoryAudit } from "./ports/audit.js";
import { InMemoryApprovalQueue, InMemoryCrm } from "./ports/crm.js";
import { ScriptedLlm } from "./ports/llm.js";

/**
 * `npm run demo` -- pushes all ten fixtures through the pipeline and prints the
 * decision for each, plus the audit trail for one of them. Everything runs
 * offline against the scripted model.
 */

const crm = new InMemoryCrm();
const approvals = new InMemoryApprovalQueue();
const audit = new InMemoryAudit();
const deps: RunDeps = {
  llm: new ScriptedLlm(scriptMap()),
  crm,
  approvals,
  audit,
  seenExternalIds: new Set<string>(),
};

const pad = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s.padEnd(n));

console.log("\nBEDA enquiry triage — decision table\n");
console.log(
  pad("fixture", 28) + pad("intent", 24) + pad("action", 22) + pad("destination", 18) + "owner",
);
console.log("-".repeat(110));

for (const [name, fixture] of Object.entries(ALL_FIXTURES)) {
  const out = await processEnquiry(fixture, deps);
  console.log(
    pad(name, 28) +
      pad(out.decision.intent, 24) +
      pad(out.decision.action, 22) +
      pad(out.decision.destination, 18) +
      out.decision.owner,
  );
  for (const r of out.decision.reasons) console.log("    · " + r);
}

console.log("\nSide effects");
console.log("-".repeat(110));
console.log("  CRM contacts created        : " + crm.contacts.size);
console.log("  CRM deals created           : " + crm.deals.length);
console.log("  Replies queued for approval : " + approvals.items.length);
console.log("  Replies actually sent       : 0   <- by construction, not by luck");

console.log("\nAudit trail for email-001");
console.log("-".repeat(110));
for (const e of await audit.forEnquiry("email-001")) {
  console.log(`  #${e.seq}  ${pad(e.stage, 14)} ${pad(e.actor, 18)} ${e.summary}`);
}
const v = await audit.verify();
console.log("\n  chain intact: " + v.ok + "\n");
