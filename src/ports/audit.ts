import { createHash } from "node:crypto";

/**
 * Append-only, hash-chained audit log.
 *
 * Every stage writes one entry. Each entry carries the hash of the previous
 * one, so a deleted or edited row breaks the chain and `verify()` fails. That
 * matters for two reasons beyond tidiness: candidate PII decisions have to be
 * defensible under Indonesian and Australian privacy law, and when a client
 * says "nobody replied to me", the chain is the answer.
 *
 * The log records the model id, the prompt hash and the cost of every inference
 * -- not the prompt itself, which may contain PII. The raw enquiry lives once,
 * in the encrypted enquiry store, referenced by id.
 */
export interface AuditEntry {
  seq: number;
  at: string;
  enquiryId: string;
  stage: string;
  /** "system" | "model:<id>" | "user:<email>" -- who caused this. */
  actor: string;
  summary: string;
  /** Small, non-PII details only. */
  detail: Record<string, string | number | boolean | null>;
  prevHash: string;
  hash: string;
}

export interface AuditPort {
  append(e: Omit<AuditEntry, "seq" | "at" | "prevHash" | "hash">): Promise<AuditEntry>;
  forEnquiry(enquiryId: string): Promise<AuditEntry[]>;
  verify(): Promise<{ ok: boolean; brokenAtSeq: number | null }>;
}

const GENESIS = "0".repeat(64);

export class InMemoryAudit implements AuditPort {
  private entries: AuditEntry[] = [];

  async append(e: Omit<AuditEntry, "seq" | "at" | "prevHash" | "hash">): Promise<AuditEntry> {
    const prev = this.entries.at(-1);
    const seq = (prev?.seq ?? 0) + 1;
    const at = new Date(Date.UTC(2026, 0, 1, 0, 0, seq)).toISOString();
    const prevHash = prev?.hash ?? GENESIS;
    const body = { seq, at, prevHash, ...e };
    const hash = createHash("sha256").update(JSON.stringify(body)).digest("hex");
    const entry: AuditEntry = { ...body, hash };
    this.entries.push(entry);
    return entry;
  }

  async forEnquiry(enquiryId: string): Promise<AuditEntry[]> {
    return this.entries.filter((e) => e.enquiryId === enquiryId);
  }

  async verify(): Promise<{ ok: boolean; brokenAtSeq: number | null }> {
    let prevHash = GENESIS;
    for (const e of this.entries) {
      const { hash, ...body } = e;
      const expected = createHash("sha256")
        .update(JSON.stringify({ ...body, prevHash }))
        .digest("hex");
      if (expected !== hash || e.prevHash !== prevHash) return { ok: false, brokenAtSeq: e.seq };
      prevHash = hash;
    }
    return { ok: true, brokenAtSeq: null };
  }

  /** Test helper: tamper with a row to prove the chain actually catches it. */
  _tamper(seq: number, summary: string): void {
    const target = this.entries.find((e) => e.seq === seq);
    if (target) target.summary = summary;
  }
}
