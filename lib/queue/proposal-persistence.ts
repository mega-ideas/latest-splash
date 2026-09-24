import { loadOpenProposals, loadProposalKeyFamily, upsertProposal } from '../db/proposal-repo.ts';
import { idempotencyKeyGeneration, type InMemoryProposalStore } from './proposal-state.ts';
import type { UnsignedProposal } from '../agent/types';

/**
 * W1 PR-B — glue between the hot in-memory proposal store and Postgres.
 *
 * - With DATABASE_URL set (DigitalOcean cluster), every store mutation
 *   write-throughs to the proposals/approvals tables, and the store hydrates
 *   open proposals on first touch after boot — a pending approval survives a
 *   cold start.
 * - Without DATABASE_URL (local demo today), everything stays in-memory and
 *   behavior is unchanged. The pglite test suite exercises the DB path.
 */

export function proposalPersistenceEnabled(): boolean {
  return Boolean(process.env.DATABASE_URL);
}

async function db() {
  const { getDb } = await import('../db/client.ts');
  return getDb();
}

export function makeProposalWriter(): ((proposal: UnsignedProposal) => Promise<void>) | undefined {
  if (!proposalPersistenceEnabled()) return undefined;
  return async (proposal) => {
    await upsertProposal(await db(), proposal);
  };
}

const hydrated = { done: false, inFlight: null as Promise<void> | null };

/** Idempotent boot hydration — await from any async server context (queue
 *  page, proposal API routes) before reading the store after a restart. */
export async function ensureProposalStoreHydrated(store: InMemoryProposalStore): Promise<void> {
  if (!proposalPersistenceEnabled() || hydrated.done) return;
  hydrated.inFlight ??= (async () => {
    try {
      store.hydrate(await loadOpenProposals(await db()));
      hydrated.done = true;
    } catch (error) {
      console.error('[proposal-store] hydration failed (continuing in-memory)', error);
    } finally {
      hydrated.inFlight = null;
    }
  })();
  await hydrated.inFlight;
}

/**
 * Bring every generation of one payment's idempotency key into the hot store,
 * finished proposals included. Boot hydration leaves those out; the unique
 * index on (org_id, idempotency_key) does not, so without them the store cannot
 * say which generation a new proposal for that payment may take.
 *
 * Throws when the database cannot be read, unlike boot hydration. A generation
 * picked without seeing the rows the index holds can collide with one of them,
 * and then every write of the new proposal fails: an approval that exists only
 * in this process, with nothing saying so.
 */
export async function hydrateKeyGenerations(
  store: InMemoryProposalStore,
  orgId: string,
  baseKey: string,
): Promise<void> {
  if (!proposalPersistenceEnabled()) return;
  const family = await loadProposalKeyFamily(await db(), orgId, baseKey);
  store.hydrate(family.filter((proposal) => idempotencyKeyGeneration(baseKey, proposal.idempotencyKey) !== null));
}
