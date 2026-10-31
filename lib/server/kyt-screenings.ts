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
  isProviderAnswer,
  isScreeningKind,
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
  /** The runtime: production keeps no sandbox verdict. Default: this process. */
  env?: NodeJS.ProcessEnv;
};

/**
 * Keep one screening. A provider's reference is kept once per business: the
 * same answer offered again returns the row already kept, never a second one.
 * A verdict without the provider's reference is refused: it is not an answer.
 */
export async function recordScreening(db: DrizzleDb, input: ScreeningRecordInput): Promise<KytScreeningRow> {
  const s = input.screening;
  // Only a provider's answer here is kept as a verdict: its reference and
  // time, and never the sandbox's in production.
  const verdict = isProviderAnswer(s, input.env) ? s.verdict : null;
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
  // The same answer offered again: the row kept for THIS address. A
  // provider's reference shared by two addresses (one sanctions-list answer,
  // say) is two rows, never one address's row returned for the other.
  const [existing] = await db
    .select()
    .from(kytScreenings)
    .where(
      and(
        eq(kytScreenings.orgId, input.orgId),
        eq(kytScreenings.provider, s.provider),
        eq(kytScreenings.reference, row.reference ?? ''),
        eq(kytScreenings.chain, input.chain),
        eq(kytScreenings.address, input.address),
      ),
    )
    .limit(1);
  if (!existing || existing.address !== input.address || existing.chain !== input.chain) throw new Error('the screening could not be stored');
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

/**
 * A sanctions-list BLOCK is sticky: once this business has one for an address
 * on a chain, no later CLEAR lifts it (a re-screen during a list outage, say),
 * and nobody's re-screen asks the provider again. Only a recorded decision
 * could supersede it, and none is built (docs/v2/phase2-compliance.md).
 */
export async function stickyBlock(db: DrizzleDb, orgId: string, chain: string, address: string): Promise<KytScreeningRow | null> {
  const [row] = await db
    .select()
    .from(kytScreenings)
    .where(and(eq(kytScreenings.orgId, orgId), eq(kytScreenings.chain, chain), eq(kytScreenings.address, address), eq(kytScreenings.provider, 'chainalysis_sanctions'), eq(kytScreenings.verdict, 'BLOCK')))
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

// ─── The gate on paying a recipient ──────────────────────────────────────────

/** How old a CLEAR may be when a payment to it is opened or signed: 24 hours, unless KYT_SCREENING_MAX_AGE_HOURS says otherwise (1 to 720). */
export const DEFAULT_SCREENING_MAX_AGE_MS = 24 * 3_600_000;

export function screeningMaxAgeMs(env: NodeJS.ProcessEnv = process.env): number {
  const hours = Number((env.KYT_SCREENING_MAX_AGE_HOURS ?? '').trim());
  return Number.isInteger(hours) && hours >= 1 && hours <= 720 ? hours * 3_600_000 : DEFAULT_SCREENING_MAX_AGE_MS;
}

export type ScreeningGateDeps = {
  db: DrizzleDb;
  orgId: string;
  now: Date;
  /** The server's provider: a stale or unanswered screening is asked again. Absent, it is refused. */
  kyt?: KytProvider | null;
  maxAgeMs?: number;
  requestedBy: string;
  /** The runtime: in production a sandbox screening on file is no answer. Default: this process. */
  env?: NodeJS.ProcessEnv;
};

export type ScreeningGateRefusal = { status: 403 | 409; code: string; error: string };

/** A kept screening is a provider's answer here (lib/compliance/kyt.ts isProviderAnswer). */
export function rowIsProviderAnswer(row: KytScreeningRow | null | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(row) && isProviderAnswer({ provider: row!.provider, verdict: row!.verdict, reference: row!.reference, screenedAt: row!.screenedAt }, env);
}

function freshAnswer(row: KytScreeningRow, now: Date, maxAgeMs: number, env: NodeJS.ProcessEnv): boolean {
  if (!rowIsProviderAnswer(row, env) || !row.screenedAt) return false;
  const age = now.getTime() - row.screenedAt.getTime();
  // Dated ahead of the clock (by more than a minute) is not taken as fresh either.
  return age <= maxAgeMs && age >= -60_000;
}

/**
 * May this business pay this Sui address now? Only when its newest screening
 * here is CLEAR and fresh. BLOCK is 403, and this check never screens it
 * away; REVIEW waits for a person (409); nothing on file, or no answer, is
 * 409 (screen it first). A stale CLEAR, or an unanswered newest attempt, is
 * screened again when the server's provider is at hand, and that answer is
 * kept and decides. In production a sandbox screening on file is no answer
 * (a sandbox BLOCK still blocks). Null lets the payment through.
 */
export async function recipientScreeningGate(deps: ScreeningGateDeps, recipient: string): Promise<ScreeningGateRefusal | null> {
  let address: string;
  try {
    address = normalizeScreeningSubject('SUI', recipient).address;
  } catch {
    return { status: 409, code: 'recipient_not_screened', error: 'The recipient address cannot be screened, so it is not paid.' };
  }
  return screeningGate(deps, { chain: 'SUI', address, defaultKind: 'wallet_recipient' });
}

/**
 * May this business pay this cross-chain USDC recipient now (D5c)? The same
 * rule as a Sui recipient, on the destination address's own chain (as
 * screening names it: SOLANA, BASE, ETHEREUM, …): only this business's
 * newest screening of that address there, a fresh CLEAR. A chain Splash
 * does not screen, or an address not in its chain's format, is refused.
 */
export async function crossChainRecipientGate(deps: ScreeningGateDeps, chain: string, address: string): Promise<ScreeningGateRefusal | null> {
  let subject: { chain: string; address: string };
  try {
    subject = normalizeScreeningSubject(chain, address, 'cross_chain_recipient');
  } catch {
    return { status: 409, code: 'recipient_not_screened', error: 'The recipient address cannot be screened on its chain, so it is not paid.' };
  }
  return screeningGate(deps, { ...subject, defaultKind: 'cross_chain_recipient' });
}

/**
 * The whole destination of a cross-chain payment. On Solana CCTP mints to
 * a USDC token account, and sanctions and KYT lists name wallets, not the
 * accounts derived from them: the wallet that owns the token account (as
 * read on chain when it was saved) must be a fresh CLEAR here as well. Both
 * are checked; a BLOCK on either decides (403), then any other refusal. A
 * Solana recipient with no owner on file cannot be screened, so it is not
 * paid. This is the check for opening the payment and, once the owners'
 * cross-chain pay path signs, for signing it too.
 */
export async function crossChainDestinationGate(
  deps: ScreeningGateDeps,
  destination: { chain: string; address: string; tokenOwner: string | null },
): Promise<ScreeningGateRefusal | null> {
  const account = await crossChainRecipientGate(deps, destination.chain, destination.address);
  if (destination.chain !== 'SOLANA') return account;
  if (account?.status === 403) return account;
  if (!destination.tokenOwner) {
    return { status: 409, code: 'recipient_not_screened', error: 'The wallet that owns this Solana token account is not on file, so it cannot be screened and is not paid.' };
  }
  const owner = await crossChainRecipientGate(deps, 'SOLANA', destination.tokenOwner);
  if (owner?.status === 403) return { status: 403, code: 'recipient_blocked', error: 'The wallet that owns this token account was refused by screening. Splash will not pay it.' };
  return account ?? owner;
}

async function screeningGate(
  deps: ScreeningGateDeps,
  subject: { chain: string; address: string; defaultKind: Exclude<ScreeningKind, 'deposit'> },
): Promise<ScreeningGateRefusal | null> {
  const { chain, address } = subject;
  const env = deps.env ?? process.env;
  const maxAgeMs = deps.maxAgeMs ?? screeningMaxAgeMs(env);
  // A listing stays, whatever came after it.
  if (await stickyBlock(deps.db, deps.orgId, chain, address)) return { status: 403, code: 'recipient_blocked', error: 'This address was refused by screening. Splash will not pay it.' };
  let row = await latestScreening(deps.db, deps.orgId, chain, address);
  if (row && row.verdict !== 'BLOCK' && !freshAnswer(row, deps.now, maxAgeMs, env) && deps.kyt) {
    const kind = isScreeningKind(row.subjectKind) && row.subjectKind !== 'deposit' ? row.subjectKind : subject.defaultKind;
    const screening = await deps.kyt.screen({ chain, address, direction: 'recipient' }).catch(() => null);
    // A provider that throws leaves the old row to decide (stale: refused).
    if (screening) row = await recordScreening(deps.db, { orgId: deps.orgId, kind, chain, address, screening, requestedBy: deps.requestedBy, env });
  }
  // A BLOCK blocks whoever gave it; anything else counts only as a provider's answer here.
  if (!row || (row.verdict !== 'BLOCK' && !rowIsProviderAnswer(row, env))) {
    return { status: 409, code: 'recipient_not_screened', error: 'Screen this recipient address first. An address with no screening answer is not paid.' };
  }
  if (row.verdict === 'BLOCK') return { status: 403, code: 'recipient_blocked', error: 'This address was refused by screening. Splash will not pay it.' };
  if (row.verdict !== 'CLEAR') return { status: 409, code: 'recipient_in_review', error: 'A person reviews this address before it is paid.' };
  if (!freshAnswer(row, deps.now, maxAgeMs, env)) {
    return { status: 409, code: 'recipient_screening_stale', error: 'This address was last screened too long ago. Screen it again before paying it.' };
  }
  return null;
}

export type ScreenDeps ={ db: DrizzleDb; kyt: KytProvider; orgId: string; now: () => Date };

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
  // A sanctions listing is not asked about again: it stays (stickyBlock).
  const listed = await stickyBlock(deps.db, deps.orgId, subject.chain, subject.address);
  if (listed) return { ok: true, screening: screeningView(listed) };
  const screening = await deps.kyt.screen({ chain: subject.chain, address: subject.address, direction: 'recipient' });
  const row = await recordScreening(deps.db, { orgId: deps.orgId, kind, chain: subject.chain, address: subject.address, screening, requestedBy: input.requestedBy });
  return { ok: true, screening: screeningView(row) };
}
