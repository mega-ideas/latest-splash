/**
 * Where a payee's screening results are recorded, and where an approval reads
 * them.
 *
 * ─── The gap this closes ────────────────────────────────────────────────────
 *
 * The approval-time compliance check (`resolveComplianceForProposal`) looked
 * every beneficiary up in the agent's in-memory counterparty fixture, which no
 * real beneficiary is ever written to. A bank beneficiary created by
 * `transfers/authorize` was not found; a payroll run named its payees in prose
 * ("12 payable rows, 0 blocked"), which nothing could find. So every real
 * dual-approval payment stopped at "compliance hold" — failing closed, but for
 * a reason no screening could ever change.
 *
 * ─── Two records, one shape ─────────────────────────────────────────────────
 *
 *   A saved beneficiary (a `suppliers` row) carries its LATEST verdict on the
 *   row — `screening_verdict`, `screening_reference`, `screened_at` — which is
 *   what the wallet lane already reads. It is named in a proposal by its id.
 *
 *   A payroll payee is an address in a batch file, with no beneficiary record.
 *   It is named `wallet:<address>`, and its verdicts live only in
 *   `screening_results`.
 *
 * Every verdict recorded through here is also appended to `screening_results`
 * — subject, provider, verdict, reference, time — so a payment's clearance can
 * be traced to who said so and when, and a later verdict never erases an
 * earlier one.
 *
 * ─── What this module never does ────────────────────────────────────────────
 *
 * Decide a verdict. A verdict comes from a provider (wallet addresses:
 * Chainalysis's sanctions list, `screenWalletAddress`) or from a reviewed
 * process the compliance owner has signed off. There is no provider for bank
 * beneficiaries' names yet; until there is, they stay unscreened and payments
 * to them stay held. Nothing here defaults to clear.
 */
import 'server-only';

import { randomUUID } from 'node:crypto';

import { and, desc, eq, inArray } from 'drizzle-orm';
import type { PgDatabase } from 'drizzle-orm/pg-core';

import { screeningResults, suppliers } from '@/lib/db/schema';
import type * as schemaModule from '@/lib/db/schema';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DrizzleDb = PgDatabase<any, typeof schemaModule, any>;

export type ScreeningVerdict = 'CLEAR' | 'REVIEW' | 'BLOCK' | 'ERROR' | 'ATTESTED';

export type ScreeningSubject =
  | { kind: 'RECIPIENT'; recipientId: string }
  | { kind: 'WALLET_ADDRESS'; address: string };

/** What is on record for one subject. */
export type RecordedScreening = {
  verdict: ScreeningVerdict | null;
  reference: string | null;
  screenedAt: Date | null;
  /** The beneficiary's own KYB, as its record holds it. Only a RECIPIENT has
   *  one; a payroll address has no record to hold it. */
  recipientKyb?: 'none' | 'pending' | 'basic' | 'full' | 'rejected';
};

/** Keyed by ref. `null`: nothing on record for that subject in this org. */
export type ScreeningLookup = Map<string, RecordedScreening | null>;

const WALLET_PREFIX = 'wallet:';

/** How a subject is named in a proposal's COUNTERPARTY evidence. */
export function screeningRef(subject: ScreeningSubject): string {
  return subject.kind === 'RECIPIENT' ? subject.recipientId : `${WALLET_PREFIX}${subject.address}`;
}

/** The screenable subject a COUNTERPARTY ref names, or null for anything else
 *  (the agent's fixture counterparties, which keep their own lookup). */
export function screeningSubjectForRef(ref: string): ScreeningSubject | null {
  if (ref.startsWith(WALLET_PREFIX)) {
    const address = normalisePayeeAddress(ref.slice(WALLET_PREFIX.length));
    return address ? { kind: 'WALLET_ADDRESS', address } : null;
  }
  // `createId('rcpt')` — lib/server/operations.ts.
  if (/^rcpt_[A-Za-z0-9_-]+$/.test(ref)) return { kind: 'RECIPIENT', recipientId: ref };
  return null;
}

/** A payroll row's address, as it is screened and named. Case-insensitive on
 *  every chain a batch pays, so one address is one subject. */
export function normalisePayeeAddress(address: string): string {
  return address.trim().toLowerCase();
}

/** One COUNTERPARTY ref per distinct payee, in the order the run lists them. */
export function payeeScreeningRefs(rows: ReadonlyArray<{ address?: unknown }>): string[] {
  const refs: string[] = [];
  for (const row of rows) {
    const address = normalisePayeeAddress(typeof row.address === 'string' ? row.address : '');
    if (!address) continue;
    const ref = screeningRef({ kind: 'WALLET_ADDRESS', address });
    if (!refs.includes(ref)) refs.push(ref);
  }
  return refs;
}

function subjectId(subject: ScreeningSubject): string {
  return subject.kind === 'RECIPIENT' ? subject.recipientId : subject.address;
}

/**
 * Record one verdict: appended to the history and, for a saved beneficiary,
 * made its latest. Scoped to `orgId` — a verdict never lands on another
 * tenant's beneficiary.
 */
export async function appendScreeningResult(
  db: DrizzleDb,
  orgId: string,
  subject: ScreeningSubject,
  result: {
    provider: string;
    verdict: ScreeningVerdict;
    reference: string | null;
    screenedAt: Date;
    raw?: Record<string, unknown>;
  },
): Promise<void> {
  await db.insert(screeningResults).values({
    id: `scr_${randomUUID()}`,
    orgId,
    subjectKind: subject.kind,
    subjectId: subjectId(subject),
    provider: result.provider,
    verdict: result.verdict,
    raw: { reference: result.reference, ...(result.raw ?? {}) },
    screenedAt: result.screenedAt,
  });
  if (subject.kind === 'RECIPIENT') {
    await db
      .update(suppliers)
      .set({ screeningVerdict: result.verdict, screeningReference: result.reference, screenedAt: result.screenedAt })
      .where(and(eq(suppliers.id, subject.recipientId), eq(suppliers.orgId, orgId)));
  }
}

/**
 * What is on record for each ref, in this org. A ref that is not a screenable
 * subject is left out; one that is, but has nothing on record, maps to null.
 */
export async function latestScreenings(db: DrizzleDb, orgId: string, refs: readonly string[]): Promise<ScreeningLookup> {
  const lookup: ScreeningLookup = new Map();
  const recipients: string[] = [];
  const addresses: string[] = [];
  for (const ref of refs) {
    const subject = screeningSubjectForRef(ref);
    if (!subject) continue;
    lookup.set(ref, null);
    if (subject.kind === 'RECIPIENT') recipients.push(subject.recipientId);
    else addresses.push(subject.address);
  }

  if (recipients.length > 0) {
    const rows = await db
      .select({
        id: suppliers.id,
        verdict: suppliers.screeningVerdict,
        reference: suppliers.screeningReference,
        screenedAt: suppliers.screenedAt,
        kybStatus: suppliers.kybStatus,
      })
      .from(suppliers)
      .where(and(eq(suppliers.orgId, orgId), inArray(suppliers.id, recipients)));
    for (const row of rows) {
      lookup.set(row.id, {
        verdict: row.verdict ?? null,
        reference: row.reference ?? null,
        screenedAt: row.screenedAt ?? null,
        recipientKyb: row.kybStatus,
      });
    }
  }

  if (addresses.length > 0) {
    const rows = await db
      .select({
        subjectId: screeningResults.subjectId,
        verdict: screeningResults.verdict,
        raw: screeningResults.raw,
        screenedAt: screeningResults.screenedAt,
      })
      .from(screeningResults)
      .where(
        and(
          eq(screeningResults.orgId, orgId),
          eq(screeningResults.subjectKind, 'WALLET_ADDRESS'),
          inArray(screeningResults.subjectId, addresses),
        ),
      )
      .orderBy(desc(screeningResults.screenedAt));
    for (const row of rows) {
      const ref = screeningRef({ kind: 'WALLET_ADDRESS', address: row.subjectId });
      // Newest first: the first row seen for an address is its latest.
      if (lookup.get(ref)) continue;
      const raw = (row.raw ?? {}) as { reference?: unknown };
      lookup.set(ref, {
        verdict: row.verdict,
        reference: typeof raw.reference === 'string' ? raw.reference : null,
        screenedAt: row.screenedAt,
      });
    }
  }

  return lookup;
}

/**
 * `latestScreenings` against the application database. With no database there
 * is no record, and every subject reads as not on record — held, never clear.
 */
export async function loadLatestScreenings(orgId: string, refs: readonly string[]): Promise<ScreeningLookup> {
  if (!process.env.DATABASE_URL) {
    const empty: ScreeningLookup = new Map();
    for (const ref of refs) if (screeningSubjectForRef(ref)) empty.set(ref, null);
    return empty;
  }
  const { getDb } = await import('@/lib/db/client');
  return latestScreenings(getDb() as never, orgId, refs);
}

type WalletScreener = (address: string) => Promise<{
  verdict: 'CLEAR' | 'BLOCK' | 'ERROR' | 'ATTESTED' | null;
  reference: string | null;
  screenedAt: Date | null;
}>;

/**
 * Screen a payroll run's payees against the wallet sanctions provider and
 * record the verdicts, so they are on record when the approvers answer.
 *
 * Only addresses with no settled verdict are screened: CLEAR, BLOCK and REVIEW
 * stand until something records a newer one, the rule the wallet lane uses
 * (lib/server/wallet-screening.ts). With no provider configured the screener
 * returns no verdict and nothing is recorded — the payees stay unscreened and
 * the run stays held.
 */
export async function screenPayees(
  db: DrizzleDb,
  orgId: string,
  refs: readonly string[],
  screen: WalletScreener,
  opts: { concurrency?: number } = {},
): Promise<{ screened: number; recorded: number }> {
  const known = await latestScreenings(db, orgId, refs);
  const due = refs.filter((ref) => {
    const subject = screeningSubjectForRef(ref);
    if (subject?.kind !== 'WALLET_ADDRESS') return false;
    const verdict = known.get(ref)?.verdict ?? null;
    return verdict === null || verdict === 'ERROR';
  });

  let recorded = 0;
  let next = 0;
  const worker = async () => {
    while (next < due.length) {
      const ref = due[next];
      next += 1;
      const subject = screeningSubjectForRef(ref) as Extract<ScreeningSubject, { kind: 'WALLET_ADDRESS' }>;
      const result = await screen(subject.address);
      // No provider, or an attestation — which is never produced for a payroll
      // address and would not be screening if it were: nothing to record.
      if (!result.verdict || result.verdict === 'ATTESTED' || !result.screenedAt) continue;
      await appendScreeningResult(db, orgId, subject, {
        provider: 'chainalysis-sanctions',
        verdict: result.verdict,
        reference: result.reference,
        screenedAt: result.screenedAt,
      });
      recorded += 1;
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(opts.concurrency ?? 4, due.length)) }, worker));
  return { screened: due.length, recorded };
}

/** `screenPayees` for a run just sent for approval, against the application
 *  database and the configured wallet provider. Never throws: it runs after
 *  the response, and a screening that could not run leaves payees unscreened —
 *  held — which is the safe direction. */
export async function screenRunPayees(orgId: string, rows: ReadonlyArray<{ address?: unknown }>): Promise<void> {
  if (!process.env.DATABASE_URL) return;
  try {
    const { getDb } = await import('@/lib/db/client');
    const { screenWalletAddress } = await import('@/lib/server/wallet-screening');
    await screenPayees(getDb() as never, orgId, payeeScreeningRefs(rows), (address) => screenWalletAddress(address));
  } catch (error) {
    console.error('[screening] payroll payees could not be screened', error instanceof Error ? error.message : error);
  }
}
