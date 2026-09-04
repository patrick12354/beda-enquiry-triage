import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { MODELS } from "./config/models.js";
import { INTENT_LABELS, ROUTING, STAFF } from "./domain/taxonomy.js";
import { ingest, type IngestResult } from "./ingest/load.js";
import { runBatch, type BatchResult, type RunDeps } from "./pipeline/run.js";
import { qualify } from "./pipeline/gate.js";
import { InMemoryAudit } from "./ports/audit.js";
import { describeMode, HeuristicLlm, type LlmMode } from "./ports/heuristic-llm.js";
import { OpenRouterLlm } from "./ports/llm.js";
import { InMemoryApprovalQueue, InMemoryRecordStore } from "./ports/records.js";

/**
 * Local server for the two surfaces.
 *
 * Dependency-free on purpose — node:http and nothing else. A demo that needs
 * its own framework is a demo nobody runs, and this one has to be runnable by
 * someone who has three hours and a laptop.
 *
 *   /         the story: what was built, and why each decision went the way it did
 *   /inspect  the tool: every item, its evidence, and the approval queue
 *
 * The approval endpoints are the only mutating ones. They require a named
 * approver and they mark a draft approved. There is no send endpoint, because
 * there is no sender.
 */

const PORT = Number(process.env.PORT ?? 5173);
const here = dirname(fileURLToPath(import.meta.url));
const siteDir = join(here, "..", "site");
const webDir = join(here, "..", "web");

const apiKey = process.env.OPENROUTER_API_KEY?.trim();
const mode: LlmMode = apiKey ? "live" : "simulated";

let ingested: IngestResult;
let records = new InMemoryRecordStore();
let approvals = new InMemoryApprovalQueue();
let audit = new InMemoryAudit();
let result: BatchResult;

async function runAll(): Promise<void> {
  ingested = await ingest();
  records = new InMemoryRecordStore();
  approvals = new InMemoryApprovalQueue();
  audit = new InMemoryAudit();
  const deps: RunDeps = {
    llm: apiKey ? new OpenRouterLlm(apiKey) : new HeuristicLlm(),
    crm: ingested.crm,
    records,
    approvals,
    audit,
  };
  result = await runBatch(ingested.items, deps);
}

function json(res: ServerResponse, code: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "Cache-Control": "no-store",
  });
  res.end(payload);
}

async function readBody(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 256_000) throw new Error("Request body too large");
    chunks.push(c as Buffer);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
};

async function snapshot() {
  return {
    mode,
    modeLabel: describeMode(mode),
    models: MODELS,
    staff: STAFF,
    routing: ROUTING,
    intentLabels: INTENT_LABELS,
    crm: ingested.crm,
    ingestIssues: ingested.issues,
    batchWarnings: result.batchWarnings,
    crmDuplicates: result.crmDuplicates,
    mergeProposals: records.mergeProposals,
    entities: result.entities,
    stats: { ...result.stats, draftsSent: 0 },
    records: records.all(),
    approvals: approvals.list(),
    auditVerified: await audit.verify(),
    items: await Promise.all(
      result.outcomes.map(async (o) => ({
        id: o.item.id,
        seq: o.item.seq,
        from: o.item.fromEmail,
        fromName: o.item.fromName,
        subject: o.item.subject,
        body: o.item.body,
        attachments: o.item.attachments,
        classification: o.classification,
        extraction: Object.fromEntries(
          Object.entries(o.extraction).filter(([, v]) => v !== null),
        ),
        approximate: o.approximate,
        droppedFields: o.droppedFields,
        reconciliations: o.reconciliations,
        crmMatches: o.crmMatches,
        conflicts: o.conflicts,
        decision: o.decision,
        qualification:
          o.decision.intent === "sales_enquiry" ? qualify(o.extraction) : null,
        recordId: o.recordId,
        draftId: o.draft?.draftId ?? null,
        injectionFlags: o.injectionFlags,
        trace: await audit.forItem(o.item.id),
      })),
    ),
  };
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);

  try {
    if (url.pathname === "/api/state" && req.method === "GET") {
      return json(res, 200, await snapshot());
    }

    if (url.pathname === "/api/rerun" && req.method === "POST") {
      await runAll();
      return json(res, 200, await snapshot());
    }

    // The approval boundary, over HTTP. Note there is no /api/send.
    if (url.pathname === "/api/approve" && req.method === "POST") {
      const { draftId, approver, note } = await readBody(req);
      if (typeof approver !== "string" || approver.trim().length < 2) {
        return json(res, 400, { error: "An approval must name the person making it." });
      }
      const draft = await approvals.approve(String(draftId), approver.trim(), note);
      await audit.append({
        itemId: draft.itemId,
        stage: "approval",
        actor: `user:${approver.trim()}`,
        summary: `${draft.draftId} approved for release by ${approver.trim()}. Approval is recorded; this build has no sender, so nothing was transmitted.`,
        detail: { draftId: draft.draftId, sent: false },
      });
      return json(res, 200, await snapshot());
    }

    if (url.pathname === "/api/reject" && req.method === "POST") {
      const { draftId, approver, note } = await readBody(req);
      if (typeof approver !== "string" || approver.trim().length < 2) {
        return json(res, 400, { error: "A rejection must name the person making it." });
      }
      const draft = await approvals.reject(String(draftId), approver.trim(), note);
      await audit.append({
        itemId: draft.itemId,
        stage: "approval",
        actor: `user:${approver.trim()}`,
        summary: `${draft.draftId} rejected by ${approver.trim()}${note ? `: ${note}` : ""}.`,
        detail: { draftId: draft.draftId, sent: false },
      });
      return json(res, 200, await snapshot());
    }

    // ---- static -----------------------------------------------------------
    let path = decodeURIComponent(url.pathname);
    if (path.includes("..")) return json(res, 400, { error: "Bad path" });

    const onInspector = path === "/inspect" || path.startsWith("/inspect/");
    const root = onInspector ? webDir : siteDir;
    if (onInspector) path = path.slice(8) || "/";
    const file = path === "/" || path === "" ? "index.html" : path.replace(/^\/+/, "");

    const ext = file.slice(file.lastIndexOf("."));
    const content = await readFile(join(root, file));
    res.writeHead(200, {
      "Content-Type": MIME[ext] ?? "application/octet-stream",
      "Cache-Control": "no-store",
    });
    return res.end(content);
  } catch (err: any) {
    if (err?.code === "ENOENT") return json(res, 404, { error: "Not found" });
    return json(res, 500, { error: String(err?.message ?? err) });
  }
});

await runAll();

server.listen(PORT, () => {
  const line = "─".repeat(66);
  console.log(`\n${line}`);
  console.log("  BEDA — intake, triage and response");
  console.log(line);
  console.log(`  Story:    http://localhost:${PORT}`);
  console.log(`  Inspect:  http://localhost:${PORT}/inspect`);
  console.log(`  Brain:    ${describeMode(mode)}`);
  if (mode === "simulated") console.log("            (set OPENROUTER_API_KEY to run against a hosted model)");
  console.log(`  Items:    ${result.stats.items} processed · ${result.stats.draftsQueued} drafts awaiting approval · ${result.stats.draftsSent} sent`);
  console.log(`  Stop:     Ctrl+C, or close this window`);
  console.log(`${line}\n`);
});
