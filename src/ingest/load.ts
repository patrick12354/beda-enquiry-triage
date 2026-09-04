import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { WorkItemSchema, type CrmRow, type WorkItem } from "../domain/schema.js";
import { parseCsvRecords } from "./csv.js";

/**
 * Ingestion. Reads the four supplied sources off disk and normalises them.
 *
 * Everything here is deterministic and defensive. The pack is fixed and known,
 * but the loader is written as if it were not, because "the input is always
 * well-formed" is the assumption that breaks first in production and the brief
 * asks explicitly for every item to be treated as untrusted.
 *
 * Three specific defences:
 *  - An email may reference an attachment the pack does not contain. That is
 *    recorded as `resolved: false`, not thrown away and not faked.
 *  - A document with no referencing email is still ingested, as an orphan, so
 *    it appears in the inspector instead of vanishing.
 *  - The CRM export is parsed strictly; malformed rows are reported, not padded.
 */

const here = dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = join(here, "..", "..", "data");

export interface StaffEntry {
  id: string;
  name: string;
  role: string;
  owns: string;
}

export interface IngestResult {
  items: WorkItem[];
  crm: CrmRow[];
  staff: StaffEntry[];
  documents: Map<string, string>;
  /** Non-fatal problems found while reading. Surfaced, never swallowed. */
  issues: string[];
}

/** Split "Amelia Grant <amelia.grant@x.example>" into its parts. */
export function parseFrom(raw: string): { name: string | null; email: string | null } {
  const angled = raw.match(/^\s*(.*?)\s*<([^>]+)>\s*$/);
  if (angled) {
    const name = (angled[1] ?? "").trim();
    return { name: name.length > 0 ? name : null, email: (angled[2] ?? "").trim().toLowerCase() };
  }
  const bare = raw.trim();
  if (bare.includes("@")) return { name: null, email: bare.toLowerCase() };
  return { name: bare, email: null };
}

export async function ingest(dataDir: string = DATA_DIR): Promise<IngestResult> {
  const issues: string[] = [];

  // --- documents -------------------------------------------------------
  const documents = new Map<string, string>();
  const docDir = join(dataDir, "documents");
  let docNames: string[] = [];
  try {
    docNames = (await readdir(docDir)).filter((f) => f.endsWith(".txt")).sort();
  } catch {
    issues.push("no documents/ directory found; attachments will be unresolved");
  }
  for (const name of docNames) {
    documents.set(name, await readFile(join(docDir, name), "utf8"));
  }

  // --- staff -----------------------------------------------------------
  const staff = JSON.parse(await readFile(join(dataDir, "staff.json"), "utf8")) as StaffEntry[];

  // --- CRM -------------------------------------------------------------
  const { records, errors } = parseCsvRecords(await readFile(join(dataDir, "crm.csv"), "utf8"));
  for (const e of errors) issues.push(`crm.csv line ${e.line}: ${e.reason}`);
  const crm: CrmRow[] = records.map((r) => ({
    id: r.id ?? "",
    company: r.company ?? "",
    contact: r.contact ?? "",
    email: r.email ?? "",
    phone: r.phone ?? "",
    location: r.location ?? "",
    stage: r.stage ?? "",
    interest: r.interest ?? "",
    status: r.status ?? "",
  }));

  // --- emails ----------------------------------------------------------
  const rawEmails = JSON.parse(await readFile(join(dataDir, "emails.json"), "utf8")) as Array<{
    id: string;
    seq: number;
    from: string;
    subject: string;
    body: string;
    attachments: string[];
  }>;

  const referenced = new Set<string>();
  const items: WorkItem[] = rawEmails.map((e) => {
    const { name, email } = parseFrom(e.from);
    const attachments = e.attachments.map((filename) => {
      referenced.add(filename);
      const text = documents.get(filename);
      if (text === undefined) {
        // The email says a file exists and the pack does not contain it. The
        // honest record is "referenced, missing" -- never an empty string that
        // downstream code would read as "the document said nothing".
        issues.push(`${e.id} references ${filename}, which is not in the pack`);
        return { filename, text: "", resolved: false };
      }
      return { filename, text, resolved: true };
    });

    return WorkItemSchema.parse({
      id: e.id,
      seq: e.seq,
      source: "email",
      fromName: name,
      fromEmail: email,
      subject: e.subject,
      body: e.body,
      attachments,
    });
  });

  for (const name of documents.keys()) {
    if (!referenced.has(name)) {
      issues.push(`${name} is in the pack but no email references it (orphan document)`);
    }
  }

  return { items, crm, staff, documents, issues };
}

/**
 * The exact text a model is shown for an item, and — importantly — the exact
 * text the grounding check validates spans against. These MUST be the same
 * string, or spans the model copied honestly get rejected as invented.
 *
 * Attachments are labelled and delimited rather than concatenated, so a span
 * can be attributed to the body or to a named file.
 */
export function renderForModel(item: WorkItem): string {
  const head = [
    `item: ${item.id}`,
    item.fromName ? `from name: ${item.fromName}` : null,
    item.fromEmail ? `from email: ${item.fromEmail}` : null,
    item.subject ? `subject: ${item.subject}` : null,
    "",
    item.body,
  ].filter((x): x is string => x !== null);

  const docs = item.attachments.map((a) =>
    a.resolved
      ? `\n--- attachment: ${a.filename} ---\n${a.text.trim()}`
      : `\n--- attachment: ${a.filename} (referenced but not supplied) ---`,
  );

  return [...head, ...docs].join("\n");
}

/** The searchable text for one named origin, used by the grounding check. */
export function sourceTextFor(item: WorkItem, origin: string): string | null {
  if (origin === "body") {
    return [item.fromName ?? "", item.fromEmail ?? "", item.subject ?? "", item.body].join("\n");
  }
  const att = item.attachments.find((a) => a.filename === origin);
  if (!att || !att.resolved) return null;
  return att.text;
}
