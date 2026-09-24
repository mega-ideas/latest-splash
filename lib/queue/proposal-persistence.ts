import { loadOpenProposalByKey, loadOpenProposals, upsertProposal } from '../db/proposal-repo.ts';
import type { InMemoryProposalStore } from './proposal-state.ts';
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

type Hydration = { done: boolean; inFlight: Promise<boolean> | null };

/**
 * Hydration state, per store.
 *
 * It was one flag for the module. A second store (a test's fresh store, or one
 * that replaced the first) was taken as hydrated because the first had been,
 * and started empty. Kept on globalThis because route handlers and server
 * components load separate copies of this module in dev, while the store they
 * share lives on globalThis (lib/agent/oxwal.ts).
 */
const hydrationGlobal = globalThis as typeof globalThis & {
  splashProposalHydrations?: WeakMap<InMemoryProposalStore, Hydration>;
};
const hydrations = (hydrationGlobal.splashProposalHydrations ??= new WeakMap());

function hydrateOnce(store: InMemoryProposalStore): Promise<boolean> {
  if (!proposalPersistenceEnabled()) return Promise.resolve(true);
  let state = hydrations.get(store);
  if (!state) {
    state = { done: false, inFlight: null };
    hydrations.set(store, state);
  }
  if (state.done) return Promise.resolve(true);
  const hydration = state;
  hydration.inFlight ??= (async () => {
    try {
      store.hydrate(await loadOpenProposals(await db()));
      hydration.done = true;
      return true;
    } catch (error) {
      console.error('[proposal-store] hydration failed (continuing in-memory)', error);
      return false;
    } finally {
      hydration.inFlight = null;
    }
  })();
  return hydration.inFlight;
}

/**
 * Get the store ready to be read — await from any async server context (queue
 * page, proposal API routes) before reading it.
 *
 * Hydrates once per store after a restart, then lapses whatever has passed its
 * expiry since the last read, which is when "expired" starts to mean anything
 * to a reader: out of the pending lane, and no longer absorbing a
 * re-submission of its payment.
 *
 * True when the store reflects Postgres (or there is no Postgres). False when
 * hydration failed: the store holds only what this process made. A reader that
 * only shows proposals can go on; one about to create a proposal for a payment
 * should not, since the one already in flight may be the one it cannot see.
 */
export async function ensureProposalStoreHydrated(store: InMemoryProposalStore): Promise<boolean> {
  const hydrated = await hydrateOnce(store);
  store.expireStale();
  return hydrated;
}

/**
 * Bring in the proposal in flight for one payment, if Postgres has one.
 *
 * Boot hydration sees what was in flight when this process started. Another
 * process can have proposed the same payment since: a second instance, or the
 * old one during a rolling deploy. Without this the re-submission it should
 * have absorbed makes a second proposal, which the unique index then refuses
 * to store. One indexed read, before creating.
 *
 * False when Postgres cannot be read.
 */
export async function hydrateOpenProposalForKey(
  store: InMemoryProposalStore,
  orgId: string,
  idempotencyKey: string,
): Promise<boolean> {
  if (!proposalPersistenceEnabled()) return true;
  try {
    const open = await loadOpenProposalByKey(await db(), orgId, idempotencyKey);
    if (open) store.hydrate([open]);
    return true;
  } catch (error) {
    console.error('[proposal-store] could not read the proposal in flight for a payment', error);
    return false;
  }
}
