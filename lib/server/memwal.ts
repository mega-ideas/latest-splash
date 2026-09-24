/**
 * MemWal (Walrus Memory) — privacy-first AI memory for the Splash Copilot.
 *
 * A delegate Ed25519 key signs requests to the MemWal relayer (a TEE that does
 * embedding, SEAL encryption, and Walrus storage server-side). The private key
 * NEVER leaves the server — this module must only be imported from server code
 * (API routes / server actions).
 *
 * Every read and write is scoped to one org (lib/server/memwal-scope.ts): its
 * own namespace, and its key at the start of every stored memory, checked
 * again on recall. There is deliberately no unscoped remember or recall here.
 * The org is the SESSION's — callers take it from `requireSessionAccount` or
 * `resolveAuthorityForSession`, never from the request.
 *
 * Every helper is defensive: if MemWal is unconfigured or the relayer errors
 * (e.g. 401 before the delegate key is registered), it degrades to a no-op so
 * the Copilot keeps working without memory rather than crashing.
 *
 * Env (see .env.example):
 *   MEMWAL_PRIVATE_KEY  – delegate Ed25519 private key (hex)         [secret]
 *   MEMWAL_ACCOUNT_ID   – Walrus Memory account object ID on Sui
 *   MEMWAL_SERVER_URL   – relayer URL (default relayer.memory.walrus.xyz)
 *   MEMWAL_NAMESPACE    – namespace PREFIX (default "splash-copilot"); each
 *                         org gets `<prefix>:org:<key>` under it
 */

import { MemWal } from '@mysten-incubation/memwal';

import { DEFAULT_MEMWAL_NAMESPACE, orgScopedMemory, type RecalledMemory } from '@/lib/server/memwal-scope';

export type { RecalledMemory };

const DEFAULT_SERVER_URL = 'https://relayer.memory.walrus.xyz';

let client: MemWal | null = null;
let warned = false;

export function memwalConfigured(): boolean {
  return Boolean(process.env.MEMWAL_PRIVATE_KEY && process.env.MEMWAL_ACCOUNT_ID);
}

/**
 * Lazily build a singleton MemWal client, or null when unconfigured. No
 * default namespace is set on it: every call names the org's own.
 */
function getClient(): MemWal | null {
  if (!memwalConfigured()) {
    if (!warned) {
      console.warn('[memwal] disabled — set MEMWAL_PRIVATE_KEY and MEMWAL_ACCOUNT_ID in .env.local');
      warned = true;
    }
    return null;
  }
  if (!client) {
    client = MemWal.create({
      key: process.env.MEMWAL_PRIVATE_KEY!,
      accountId: process.env.MEMWAL_ACCOUNT_ID!,
      serverUrl: process.env.MEMWAL_SERVER_URL ?? DEFAULT_SERVER_URL,
    });
  }
  return client;
}

function scopedMemory() {
  const m = getClient();
  return m ? orgScopedMemory(m, process.env.MEMWAL_NAMESPACE || DEFAULT_MEMWAL_NAMESPACE) : null;
}

/**
 * Semantic recall within one org's memory. Returns [] for an empty org, and
 * on any error (never throws).
 */
export async function recallForOrg(orgId: string, query: string, limit = 5): Promise<RecalledMemory[]> {
  const memory = scopedMemory();
  if (!memory) return [];
  try {
    return await memory.recall(orgId, query, limit);
  } catch (error) {
    console.warn('[memwal] recall failed:', (error as Error)?.message ?? String(error));
    return [];
  }
}

/**
 * Persist a memory for one org (the server accepts it as a background job).
 * false when nothing was stored: unconfigured, no org, empty text, or error.
 */
export async function rememberForOrg(orgId: string, text: string): Promise<boolean> {
  const memory = scopedMemory();
  if (!memory) return false;
  try {
    return await memory.remember(orgId, text);
  } catch (error) {
    console.warn('[memwal] remember failed:', (error as Error)?.message ?? String(error));
    return false;
  }
}

/** Liveness probe for the relayer (public, unsigned). null on failure. */
export async function memwalHealth(): Promise<unknown | null> {
  const m = getClient();
  if (!m) return null;
  try {
    return await m.health();
  } catch {
    return null;
  }
}
