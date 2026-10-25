/**
 * Screening the addresses a business pays (v2 §4.6): a self-custody wallet
 * on Sui, an exchange deposit address on Sui, a cross-chain USDC recipient
 * (Solana, Ethereum, Base, …). Deposits are screened on arrival by the
 * funding service (lib/server/wallet-funding.ts) through the same provider
 * (`kytProviderFromEnv`), and that answer is kept on the deposit's own row.
 *
 * Every screening is kept (`kyt_screenings`, append-only), the unanswered
 * ones as well: "we asked, and the provider did not answer" is evidence, and
 * it is never a CLEAR. Every read and write takes the org (WS2): another
 * business's screening of the same address does not count for this one.
 */
import { randomUUID } from 'node:crypto';

import { and, desc, eq } from 'drizzle-orm';

import { kytScreenings } from '../db/schema.ts';
import {
  normalizeScreeningSubject,
  ScreeningSubjectError,
  screeningPermitsPayment,
  type KytProvider,
  type KytScreening,
  type ScreeningKind,
} from '../compliance/kyt.ts';
import type { DrizzleDb } from './wallet-signing-store.ts';

export type KytScreeningRow = typeof kytScreenings.$inferSelect;

export type ScreeningRecordInput = {
  orgId: string;
  kind: ScreeningKind;
  chain: string;
  address: string;
  txRef?: string | null;
  screening: KytScreening;
  requestedBy: string;
};

/**
 * Keep one screening. A provider's reference is kept once per business: the
 * same answer offered again returns the row already kept, never a second one.
 * A verdict without the provider's reference is refused: it is not an answer.
 */
export async function recordScreening(db: DrizzleDb, input: ScreeningRecordInput): Promise<KytScreeningRow> {
  const s = input.screening;
  const verdict = s.verdict !== null && s.reference && s.screenedAt ? s.verdict : null;
  const row = {
    id: `kyt_${randomUUID()}`,
    orgId: input.orgId,
    subjectKind: input.kind,
    chain: input.chain,
    address: input.address,
    txRef: input.txRef ?? null,
    provider: s.provider,
    verdict,
    reference: verdict ? s.reference : null,
    riskScore: typeof s.riskScore === 'number' ? String(s.riskScore) : null,
    detail: s.detail.slice(0, 500),
    screenedAt: verdict && s.screenedAt ? new Date(s.screenedAt) : null,
    requestedBy: input.requestedBy,
  };
  const [inserted] = await db.insert(kytScreenings).values(row).onConflictDoNothing().returning();
  if (inserted) return inserted;
  const [existing] = await db
    .select()
    .from(kytScreenings)
    .where(and(eq(kytScreenings.orgId, input.orgId), eq(kytScreenings.provider, s.provider), eq(kytScreenings.reference, row.reference ?? '')))
    .limit(1);
  if (!existing) throw new Error('the screening could not be stored');
  return existing;
}

/** This business's latest screening of one address on one chain, or null. */
export async function latestScreening(db: DrizzleDb, orgId: string, chain: string, address: string): Promise<KytScreeningRow | null> {
  const [row] = await db
    .select()
    .from(kytScreenings)
    .where(and(eq(kytScreenings.orgId, orgId), eq(kytScreenings.chain, chain), eq(kytScreenings.address, address)))
    .orderBy(desc(kytScreenings.createdAt))
    .limit(1);
  return row ?? null;
}

/** This business's screenings of one address, newest first. */
export async function screeningsOf(db: DrizzleDb, orgId: string, chain: string, address: string, limit = 20): Promise<KytScreeningRow[]> {
  return db
    .select()
    .from(kytScreenings)
    .where(and(eq(kytScreenings.orgId, orgId), eq(kytScreenings.chain, chain), eq(kytScreenings.address, address)))
    .orderBy(desc(kytScreenings.createdAt))
    .limit(limit);
}

export type ScreeningView = {
  id: string;
  kind: string;
  chain: string;
  address: string;
  provider: string;
  verdict: string | null;
  reference: string | null;
  riskScore: string | null;
  detail: string;
  screenedAt: string | null;
  /** True only on CLEAR: REVIEW waits for a person, null is unscreened. */
  permitsPayment: boolean;
};

export function screeningView(row: KytScreeningRow): ScreeningView {
  return {
    id: row.id,
    kind: row.subjectKind,
    chain: row.chain,
    address: row.address,
    provider: row.provider,
    verdict: row.verdict,
    reference: row.reference,
    riskScore: row.riskScore,
    detail: row.detail,
    screenedAt: row.screenedAt ? row.screenedAt.toISOString() : null,
    permitsPayment: screeningPermitsPayment({ verdict: row.verdict as KytScreening['verdict'] }),
  };
}

export type ScreenDeps = { db: DrizzleDb; kyt: KytProvider; orgId: string; now: () => Date };

/**
 * Screen one recipient address for this business and keep the answer. The
 * address is checked against its chain first (a wrong format is refused,
 * never screened). The provider is asked every time: a recipient is screened
 * when it is added and again before it is paid, and the newest answer is the
 * one that counts.
 */
export async function screenRecipient(
  deps: ScreenDeps,
  input: { kind: unknown; chain: unknown; address: unknown; requestedBy: string },
): Promise<{ ok: true; screening: ScreeningView } | { ok: false; status: 400; code: string; error: string }> {
  const kind = input.kind;
  if (kind !== 'wallet_recipient' && kind !== 'exchange_recipient' && kind !== 'cross_chain_recipient') {
    return { ok: false, status: 400, code: 'bad_kind', error: 'Screen a wallet, exchange or cross-chain recipient.' };
  }
  let subject: { chain: string; address: string };
  try {
    subject = normalizeScreeningSubject(input.chain, input.address, kind);
  } catch (error) {
    if (error instanceof ScreeningSubjectError) return { ok: false, status: 400, code: error.code, error: error.message };
    throw error;
  }
  const screening = await deps.kyt.screen({ chain: subject.chain, address: subject.address, direction: 'recipient' });
  const row = await recordScreening(deps.db, { orgId: deps.orgId, kind, chain: subject.chain, address: subject.address, screening, requestedBy: input.requestedBy });
  return { ok: true, screening: screeningView(row) };
}
