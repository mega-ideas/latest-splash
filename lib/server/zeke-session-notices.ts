/**
 * What Zeke has already said once in this sign-in session (v2 §4.8).
 *
 * Two things are said at most once per session: the read-only limitation
 * statement ("I can read your balances … but I can't move money …") and the
 * nudge to save a first recipient. The money-moving statement is not here —
 * it is said every time, so there is nothing to remember.
 *
 * ─── Why the server remembers, not the thread ──────────────────────────────
 *
 * The chat history is client state: the floating widget forgets it when it
 * remounts, the desk sends only its last few turns, and a client can send any
 * history it likes. "Once per session" judged from that alone is once per
 * mount. So a claim is recorded per org, sign-in session and notice, and the
 * primary key on those three is the "once": the claim is an insert that lands
 * (say it) or conflicts (already said). Two tabs, two instances, or a retried
 * request get one winner.
 *
 * ─── The session key ───────────────────────────────────────────────────────
 *
 * A hash of the signed session's email and mint time — derived by the route
 * from the cookie it verified, never from the request body. A new sign-in is a
 * new session; the email itself is never stored.
 *
 * ─── Failing closed ────────────────────────────────────────────────────────
 *
 * In production without a database the ledger refuses (`claimZekeNotice`
 * throws) rather than keeping claims in one process. The caller turns that
 * into the safe answer for each notice: a limitation statement is said
 * anyway (over-stating a limit costs a sentence), and the nudge is not (a
 * "once" nobody can prove is a "never"). Outside production with no database,
 * claims live in this process, for local development and tests.
 */
import { createHash } from 'node:crypto';

import { lt } from 'drizzle-orm';

import { zekeSessionNotices } from '../db/schema.ts';
import { isProductionRuntime } from './runtime-mode.ts';

export type ZekeSessionNotice = 'READ_LIMIT' | 'FIRST_RECIPIENT';

/** Longer than any customer session lives; older rows can never match again. */
const RETAIN_MS = 31 * 24 * 60 * 60 * 1000;

type MemoryGlobal = typeof globalThis & { splashZekeSessionNotices?: Map<string, number> };
const memoryGlobal = globalThis as MemoryGlobal;

function memory(): Map<string, number> {
  memoryGlobal.splashZekeSessionNotices ??= new Map();
  return memoryGlobal.splashZekeSessionNotices;
}

/** The session key for a verified customer session. */
export function zekeSessionKey(session: { email: string; issuedAt: string }): string {
  return createHash('sha256').update(`zeke-session\u0000${session.email.toLowerCase()}\u0000${session.issuedAt}`).digest('hex');
}

/**
 * Claim a notice for this org and session. True the first time — say it —
 * and false every time after. Throws when the ledger is not available
 * (production with no database); the caller decides the safe answer.
 */
export async function claimZekeNotice(input: {
  orgId: string;
  sessionKey: string;
  notice: ZekeSessionNotice;
  now?: Date;
}): Promise<boolean> {
  const { orgId, sessionKey, notice } = input;
  if (!orgId || !sessionKey) throw new Error('a Zeke notice needs an org and a session');
  const now = input.now ?? new Date();

  if (!process.env.DATABASE_URL) {
    if (isProductionRuntime()) {
      throw new Error('the Zeke session ledger is not available: DATABASE_URL is not set');
    }
    const store = memory();
    for (const [key, at] of store) if (now.getTime() - at > RETAIN_MS) store.delete(key);
    const key = JSON.stringify([orgId, sessionKey, notice]);
    if (store.has(key)) return false;
    store.set(key, now.getTime());
    return true;
  }

  const { getDb } = await import('../db/client.ts');
  const db = getDb();
  await db.delete(zekeSessionNotices).where(lt(zekeSessionNotices.shownAt, new Date(now.getTime() - RETAIN_MS)));
  const inserted = await db
    .insert(zekeSessionNotices)
    .values({ orgId, sessionKey, notice, shownAt: now })
    .onConflictDoNothing()
    .returning({ notice: zekeSessionNotices.notice });
  return inserted.length > 0;
}

/** Tests only: forget the in-process claims. */
export function resetZekeSessionNoticesForTesting(): void {
  memory().clear();
}
