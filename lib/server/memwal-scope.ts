/**
 * Tenant scoping for MemWal (Walrus Memory).
 *
 * MemWal here is one account, one delegate key and free-text semantic search.
 * The adapter used to put every workspace's memories in ONE namespace, so a
 * recall for one org searched every org: `parseInvoice` remembered "Invoice
 * vendor <name> settles in <ccy>" for any tenant, and the copilot suggestion
 * cards print a recalled memory word for word. One workspace could read
 * another's counterparty names.
 *
 * A memory now has to pass two independent fences to be recalled:
 *
 *   1. Namespace. Every write and every recall names the org's own namespace,
 *      `<base>:org:<key>`, so the relayer only searches that org's vectors.
 *   2. Key in the text. Every stored memory begins with `[org:<key>] `, and a
 *      recall keeps only memories that begin with the caller's exact key. If
 *      the relayer ever ignores or mis-routes a namespace, another org's
 *      memory is dropped here instead of trusted.
 *
 * `<key>` is a digest of the org id, not the id itself. That gives it a fixed
 * charset and length whatever an id looks like, it cannot contain the tag's
 * delimiter, and the relayer's namespace metadata does not carry tenant ids in
 * the clear. It partitions, it does not authenticate: only this server chooses
 * a namespace, and no request or model output ever names one.
 *
 * The org always comes from the session (`requireSessionAccount`,
 * `resolveAuthorityForSession`), never from a request body, a query string or
 * a model's tool input. An empty org scopes to nothing: no write, no recall.
 *
 * Pure apart from the injected backend, so the isolation is tested without a
 * relayer (tests/memwal-tenant-scope.test.mjs).
 */
import { createHash } from 'node:crypto';

export const DEFAULT_MEMWAL_NAMESPACE = 'splash-copilot';

export type RecalledMemory = { text: string; distance: number };

/** What the relayer hands back for one hit. `text` is decrypted plaintext. */
export type RawMemory = { text?: string | null; distance: number };

/**
 * The subset of the MemWal client this module drives. The SDK's own
 * `MemWal` satisfies it; tests pass an in-memory fake.
 */
export type MemoryBackend = {
  remember(text: string, namespace: string): Promise<unknown>;
  recall(params: { query: string; limit: number; namespace: string }): Promise<{
    results: ReadonlyArray<RawMemory>;
  }>;
};

/**
 * The org's partition key: 64 bits of SHA-256 over the org id, as hex. null
 * for an empty or blank id, which must never share a partition with anything.
 * The id is hashed as given, not trimmed, so two distinct ids cannot collapse
 * into one key.
 */
export function orgMemoryKey(orgId: string): string | null {
  if (typeof orgId !== 'string' || !orgId.trim()) return null;
  return createHash('sha256').update(`splash-memwal-org:${orgId}`, 'utf8').digest('hex').slice(0, 16);
}

/** The namespace every write and recall for this org uses, or null. */
export function orgNamespace(orgId: string, base: string = DEFAULT_MEMWAL_NAMESPACE): string | null {
  const key = orgMemoryKey(orgId);
  return key ? `${base.trim() || DEFAULT_MEMWAL_NAMESPACE}:org:${key}` : null;
}

/** The prefix every memory stored for this org starts with, or null. */
export function orgMemoryTag(orgId: string): string | null {
  const key = orgMemoryKey(orgId);
  return key ? `[org:${key}] ` : null;
}

/**
 * The text as stored for this org: its tag first, then the memory on one
 * line. null when there is no org or nothing to store.
 */
export function textForOrg(orgId: string, text: string): string | null {
  const tag = orgMemoryTag(orgId);
  const body = typeof text === 'string' ? text.replace(/\s+/g, ' ').trim() : '';
  return tag && body ? `${tag}${body}` : null;
}

/**
 * The recalled memories that belong to this org, with the tag removed. A
 * memory without the caller's exact tag is dropped, whichever namespace it
 * arrived from: another org's, an untagged one written before scoping, or
 * one whose text merely mentions the tag somewhere after the start.
 */
export function memoriesForOrg(orgId: string, memories: ReadonlyArray<RawMemory>): RecalledMemory[] {
  const tag = orgMemoryTag(orgId);
  if (!tag) return [];
  const out: RecalledMemory[] = [];
  for (const memory of memories) {
    if (typeof memory?.text !== 'string' || !memory.text.startsWith(tag)) continue;
    const text = memory.text.slice(tag.length).trim();
    if (text) out.push({ text, distance: memory.distance });
  }
  return out;
}

/**
 * The only way into MemWal: every call takes the org, and there is no
 * unscoped remember or recall to reach for instead.
 */
export function orgScopedMemory(backend: MemoryBackend, base: string = DEFAULT_MEMWAL_NAMESPACE) {
  return {
    /** false when there is no org or nothing to store; nothing is written then. */
    async remember(orgId: string, text: string): Promise<boolean> {
      const namespace = orgNamespace(orgId, base);
      const stored = textForOrg(orgId, text);
      if (!namespace || !stored) return false;
      await backend.remember(stored, namespace);
      return true;
    },

    async recall(orgId: string, query: string, limit: number): Promise<RecalledMemory[]> {
      const namespace = orgNamespace(orgId, base);
      if (!namespace || typeof query !== 'string' || !query.trim()) return [];
      const result = await backend.recall({ query, limit, namespace });
      return memoriesForOrg(orgId, result?.results ?? []);
    },
  };
}
