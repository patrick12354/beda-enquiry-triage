/**
 * The CRM is behind a port so the pipeline never depends on a vendor. The
 * concrete adapter shown is HubSpot, which is the realistic choice for an
 * agency of BEDA's size, but the pipeline would not change if it were Pipedrive
 * or Close.
 *
 * Two rules are enforced here rather than in the pipeline, because they must
 * hold no matter who calls:
 *   1. Every write carries an idempotency key. A retried webhook must not
 *      create a second deal.
 *   2. There is no delete. The token issued to this service has create/update
 *      scopes only, so a bug cannot destroy client history.
 */

export interface ContactRef {
  id: string;
  email: string | null;
  name: string | null;
  companyId: string | null;
}

export interface UpsertContactInput {
  idempotencyKey: string;
  email: string | null;
  phone: string | null;
  name: string | null;
  channel: string;
  properties: Record<string, string>;
}

export interface CreateDealInput {
  idempotencyKey: string;
  contactId: string;
  pipeline: string;
  stage: string;
  title: string;
  properties: Record<string, string>;
}

export interface CrmPort {
  findContact(q: { email: string | null; phone: string | null }): Promise<ContactRef | null>;
  /** Fuzzy company lookup. Returns candidates -- it never merges on its own. */
  findCompanies(q: { domain: string | null; name: string | null }): Promise<
    Array<{ id: string; name: string; domain: string | null; score: number }>
  >;
  upsertContact(input: UpsertContactInput): Promise<ContactRef>;
  createDeal(input: CreateDealInput): Promise<{ id: string }>;
  /** Notes are always safe to add and are how we keep the trail inside the CRM. */
  addNote(contactId: string, body: string, idempotencyKey: string): Promise<void>;
}

/** In-memory adapter used by tests and the demo. */
export class InMemoryCrm implements CrmPort {
  public contacts = new Map<string, ContactRef>();
  public deals: Array<CreateDealInput & { id: string }> = [];
  public notes: Array<{ contactId: string; body: string }> = [];
  private seenKeys = new Set<string>();
  private companies: Array<{ id: string; name: string; domain: string | null }> = [];

  seedCompany(c: { id: string; name: string; domain: string | null }): void {
    this.companies.push(c);
  }
  seedContact(c: ContactRef): void {
    this.contacts.set(c.id, c);
  }

  async findContact(q: { email: string | null; phone: string | null }): Promise<ContactRef | null> {
    for (const c of this.contacts.values()) {
      if (q.email && c.email && c.email.toLowerCase() === q.email.toLowerCase()) return c;
    }
    return null;
  }

  async findCompanies(q: { domain: string | null; name: string | null }) {
    return this.companies
      .map((c) => {
        let score = 0;
        if (q.domain && c.domain && c.domain.toLowerCase() === q.domain.toLowerCase()) score = 1;
        else if (q.name && c.name.toLowerCase() === q.name.toLowerCase()) score = 0.8;
        else if (q.name && c.name.toLowerCase().includes(q.name.toLowerCase())) score = 0.5;
        return { ...c, score };
      })
      .filter((c) => c.score > 0)
      .sort((a, b) => b.score - a.score);
  }

  async upsertContact(input: UpsertContactInput): Promise<ContactRef> {
    if (this.seenKeys.has(input.idempotencyKey)) {
      const existing = await this.findContact({ email: input.email, phone: input.phone });
      if (existing) return existing;
    }
    this.seenKeys.add(input.idempotencyKey);
    const existing = await this.findContact({ email: input.email, phone: input.phone });
    if (existing) {
      const merged = { ...existing, name: existing.name ?? input.name };
      this.contacts.set(existing.id, merged);
      return merged;
    }
    const ref: ContactRef = {
      id: `contact_${this.contacts.size + 1}`,
      email: input.email,
      name: input.name,
      companyId: null,
    };
    this.contacts.set(ref.id, ref);
    return ref;
  }

  async createDeal(input: CreateDealInput): Promise<{ id: string }> {
    if (this.seenKeys.has(input.idempotencyKey)) {
      const prior = this.deals.find((d) => d.idempotencyKey === input.idempotencyKey);
      if (prior) return { id: prior.id };
    }
    this.seenKeys.add(input.idempotencyKey);
    const deal = { ...input, id: `deal_${this.deals.length + 1}` };
    this.deals.push(deal);
    return { id: deal.id };
  }

  async addNote(contactId: string, body: string, idempotencyKey: string): Promise<void> {
    if (this.seenKeys.has(idempotencyKey)) return;
    this.seenKeys.add(idempotencyKey);
    this.notes.push({ contactId, body });
  }
}

/**
 * Outbound is a separate port on purpose. Nothing in the pipeline can reach it
 * directly -- only the approval service can, and only after a named human has
 * approved a specific draft id. See docs/DESIGN.md section 8.
 */
export interface ApprovalQueuePort {
  enqueue(item: {
    enquiryId: string;
    channel: string;
    to: string;
    draftBody: string;
    intent: string;
    owner: string;
    slaMinutes: number;
    /** Facts the reviewer needs to judge the draft without opening three tabs. */
    context: Record<string, string>;
  }): Promise<{ draftId: string }>;
}

export class InMemoryApprovalQueue implements ApprovalQueuePort {
  public items: Array<{ draftId: string; enquiryId: string; to: string; draftBody: string }> = [];
  async enqueue(item: Parameters<ApprovalQueuePort["enqueue"]>[0]) {
    const draftId = `draft_${this.items.length + 1}`;
    this.items.push({ draftId, enquiryId: item.enquiryId, to: item.to, draftBody: item.draftBody });
    return { draftId };
  }
}
