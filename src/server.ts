import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { ALL_FIXTURES } from "./fixtures/enquiries.js";
import { processEnquiry, type RunDeps } from "./pipeline/run.js";
import { InMemoryAudit } from "./ports/audit.js";
import { InMemoryApprovalQueue, InMemoryCrm } from "./ports/crm.js";
import { HeuristicLlm, describeMode, type LlmMode } from "./ports/heuristic-llm.js";
import { OpenRouterLlm } from "./ports/llm.js";
import { MODELS } from "./config/models.js";
import { RawEnquirySchema } from "./domain/schema.js";

/**
 * Local demo server for the triage pipeline.
 *
 * Deliberately dependency-free -- node:http and nothing else. A demo that needs
 * its own framework is a demo nobody runs.
 *
 * State is in-memory and shared across requests on purpose: submitting the same
 * enquiry twice is how you see deduplication work, and that only reads as real
 * if the CRM remembers the first one.
 */

const PORT = Number(process.env.PORT ?? 5173);
const here = dirname(fileURLToPath(import.meta.url));
/* Two surfaces, one origin. `/` is the document, `/demo` is the running
   pipeline, and they share a bar so a reader can cross between them. */
const siteDir = join(here, "..", "site");
const webDir = join(here, "..", "web");

const apiKey = process.env.OPENROUTER_API_KEY?.trim();
const mode: LlmMode = apiKey ? "live" : "simulated";

let crm = new InMemoryCrm();
let approvals = new InMemoryApprovalQueue();
let audit = new InMemoryAudit();
let seen = new Set<string>();

function deps(): RunDeps {
  return {
    llm: apiKey ? new OpenRouterLlm(apiKey) : new HeuristicLlm(),
    crm,
    approvals,
    audit,
    seenExternalIds: seen,
  };
}

function reset(): void {
  crm = new InMemoryCrm();
  approvals = new InMemoryApprovalQueue();
  audit = new InMemoryAudit();
  seen = new Set<string>();
}

const json = (res: import("node:http").ServerResponse, code: number, body: unknown) => {
  const payload = JSON.stringify(body);
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "Cache-Control": "no-store",
  });
  res.end(payload);
};

async function readBody(req: import("node:http").IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 256_000) throw new Error("Request body too large");
    chunks.push(c as Buffer);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);

  try {
    // ---- API ------------------------------------------------------------
    if (url.pathname === "/api/state" && req.method === "GET") {
      return json(res, 200, {
        mode,
        modeLabel: describeMode(mode),
        models: MODELS,
        fixtures: Object.entries(ALL_FIXTURES).map(([key, f]) => ({
          key,
          label: key
            .toLowerCase()
            .replace(/_/g, " ")
            .replace(/^\w/, (c) => c.toUpperCase()),
          enquiry: f,
        })),
        ...snapshot(),
      });
    }

    if (url.pathname === "/api/process" && req.method === "POST") {
      const body = await readBody(req);
      const enquiry = RawEnquirySchema.parse({
        externalId: body.externalId || `demo-${Date.now()}`,
        channel: body.channel ?? "email",
        receivedAt: new Date().toISOString(),
        fromName: body.fromName || null,
        fromEmail: body.fromEmail || null,
        fromPhone: body.fromPhone || null,
        subject: body.subject || null,
        body: body.body ?? "",
        formFields: body.formFields ?? {},
        attachments: [],
        honeypotTripped: Boolean(body.honeypotTripped),
      });

      const before = (await audit.forEnquiry(enquiry.externalId)).length;
      const outcome = await processEnquiry(enquiry, deps());
      const trace = (await audit.forEnquiry(enquiry.externalId)).slice(before);

      return json(res, 200, { outcome, trace, ...snapshot() });
    }

    if (url.pathname === "/api/reset" && req.method === "POST") {
      reset();
      return json(res, 200, snapshot());
    }

    // ---- static ---------------------------------------------------------
    let path = decodeURIComponent(url.pathname);
    if (path.includes("..")) return json(res, 400, { error: "Bad path" });

    // /demo and /demo/* are the tool; everything else is the document.
    const onDemo = path === "/demo" || path.startsWith("/demo/");
    const root = onDemo ? webDir : siteDir;
    if (onDemo) path = path.slice(5) || "/";
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

function snapshot() {
  return {
    crm: {
      contacts: [...crm.contacts.values()],
      deals: crm.deals.map((d) => ({ id: d.id, title: d.title, stage: d.stage })),
      notes: crm.notes.length,
    },
    approvals: approvals.items,
    auditLength: 0,
  };
}

server.listen(PORT, () => {
  const line = "─".repeat(64);
  console.log(`\n${line}`);
  console.log("  BEDA enquiry triage — local demo");
  console.log(line);
  console.log(`  Read:   http://localhost:${PORT}`);
  console.log(`  Try:    http://localhost:${PORT}/demo`);
  console.log(`  Brain:  ${describeMode(mode)}`);
  if (mode === "simulated") {
    console.log("          (set OPENROUTER_API_KEY to run against real DeepSeek)");
  }
  console.log(`  Stop:   Ctrl+C, or just close this window`);
  console.log(`${line}\n`);
});
