import { createHash } from "node:crypto";

/**
 * Append-only, hash-chained audit log.
 *
 * Every stage writes one entry. Each entry carries the hash of the one before
 * it, so a deleted or edited row breaks the chain and `verify()` says where.
 *
 * This is not tidiness. The system makes decisions that cost money — it tells
 * finance that a $2,640 variance is real, it decides a customer's enquiry was
 * spam, it declines to answer an engineering question. When someone asks "why
 * did nobody reply to me", or "who decided this", the chain is the answer, and
 * an answer that could have been quietly rewritten afterwards is not one.
 *
 * The log records what happened and why. It records field NAMES and reason
 * codes, not the raw text of the item, which may contain personal data; the
 * item itself lives once, in the item store, referenced by id.
 *
 * Timestamps are derived from the sequence number rather than the wall clock,
 * so the same input produces a byte-identical log. That makes the audit trail
 * diffable in tests, which is the only way to notice that a change to the gate
 * quietly altered the reasoning on an item nobody was looking at.
 */
export interface AuditEntry {
  seq: number;
  at: string;
  itemId: string;
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
  forItem(itemId: string): Promise<AuditEntry[]>;
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

  async forItem(itemId: string): Promise<AuditEntry[]> {
    return this.entries.filter((e) => e.itemId === itemId);
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
