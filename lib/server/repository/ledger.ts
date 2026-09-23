/**
 * The ledger that decides whether a payment may leave.
 *
 * `lib/ledger/post.ts` is a real double-entry writer: postings that must sum to
 * zero per currency, an invariant query that proves it globally, a test suite,
 * and a paragraph in `docs/W1-BACKUPS.md` describing it as the thing you
 * believe when the state and the money disagree.
 *
 * Nothing called it. Every actual money movement — the payer debit in the
 * authorize route, the credit when a deposit lands, the debit and credit either
 * side of a sweep — went to `createLedgerEntry`, a single-entry append to a
 * `Map` on `globalThis`. And `getLedgerBalance`, which gates the payment at
 * `app/api/transfers/authorize/route.ts` with "Splash balance is insufficient",
 * summed that map.
 *
 * So the balance a payment was checked against was computed from a store that
 * emptied on every restart, and the audited ledger was written by its own test
 * and no one else. This module is the join.
 *
 * ─── Whose balance this is ──────────────────────────────────────────────────
 *
 * Keyed by ORG, not by the on-chain business account id.
 *
 * `resolveBusinessAccountId` returns the org's `sui_business_account_id`, and
 * when there is none it falls back to the env-wide `SPLASH_BUSINESS_ACCOUNT_ID`
 * and then to the literal `dashboard-primary`. Both fallbacks are shared by
 * every org that reaches them, so an account id is not a tenant key: two orgs
 * without a provisioned on-chain account resolve to the same string and would
 * have shared one balance. That is verifiable in the seeded dev database,
 * where `acme` and `northwind` both resolve to `dashboard-primary`.
 *
 * So the posting account is `account:<orgId>:<subject>`:
 *
 *   subject `self`     the org's own spendable balance — what the authorize
 *                      route checks before letting a payment leave.
 *   subject `<id>`     a beneficiary's stored balance, held inside the org's
 *                      book. A sweep credits and debits this side.
 *
 * The on-chain account id remains what it is — an object id — and is no
 * longer asked to double as an ownership boundary.
 *
 * ─── Signs ──────────────────────────────────────────────────────────────────
 *
 * `post.ts` states the convention — debits positive, credits negative — and
 * this keeps it rather than inventing a second one:
 *
 *   `account:<id>`   what we owe the customer. A liability, so money arriving
 *                    is a CREDIT and posts NEGATIVE.
 *   `splash:<kind>`  our side of the same movement, posting the negation.
 *
 * A customer's spendable balance is therefore the negation of the sum of their
 * postings. That is one minus sign in `accountBalanceMinor`, with this comment
 * behind it, and in exchange every journal balances under the same rule the
 * invariant query already checks.
 *
 * ─── Minor units ────────────────────────────────────────────────────────────
 *
 * `amount_minor` is a bigint column and these are bigint values. The in-memory
 * record used a JS `number` for micro-USDC, which is exact only below 2^53 —
 * about nine billion dollars at six decimals. Fine until it is not, and the
 * failure is silent rounding in a balance.
 */
import { and, desc, eq, gte, sql } from 'drizzle-orm';

import type { Database } from '../../db/client.ts';
import { journalEntries, ledgerPostings } from '../../db/schema.ts';

/** What one movement looks like to a caller, in the vocabulary they already use. */
export type LedgerEntryInput = {
  /** The tenant. Required — this is the ownership boundary. */
  orgId: string;
  /** `self` for the org's own balance, or a beneficiary id for a stored
   *  balance held inside that org's book. */
  subject?: string;
  direction: 'CREDIT' | 'DEBIT';
  amountMinor: bigint;
  refType: 'TRANSFER' | 'SWEEP' | 'FEE' | 'FUNDING' | 'YIELD_SIM' | 'SEED';
  refId: string;
  suiTxDigest?: string;
  currency?: string;
};

export type LedgerEntryRow = {
  id: string;
  orgId: string;
  subject: string;
  direction: 'CREDIT' | 'DEBIT';
  amountMinor: bigint;
  balanceAfterMinor: bigint;
  refType: string;
  refId: string;
  suiTxDigest?: string;
  createdAt: string;
};

/** The customer's side of a movement, inside their own tenant. */
const customerAccount = (orgId: string, subject = 'self') => `account:${orgId}:${subject}`;

/** Our side of it, named for what moved rather than lumped into one bucket, so
 *  a reconciliation can tell funding from settlement without reading refIds. */
const contraAccount = (refType: LedgerEntryInput['refType']) => `splash:${refType.toLowerCase()}`;

/**
 * Record one movement as a balanced pair.
 *
 * Takes the caller's transaction handle where there is one, so the ledger and
 * the state change it describes commit together — which is the entire reason
 * `postJournal` asks for a handle rather than opening its own.
 */
export async function recordEntry(
  db: Database,
  input: LedgerEntryInput,
): Promise<LedgerEntryRow> {
  const currency = input.currency ?? 'USDC';
  const subject = input.subject ?? 'self';
  const id = `jnl_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;

  // Money in is a credit to a liability: negative on the customer's account.
  const signed = input.direction === 'CREDIT' ? -input.amountMinor : input.amountMinor;

  const { postJournal } = await import('../../ledger/post.ts');
  await postJournal(db, {
    id,
    orgId: input.orgId,
    kind: input.refType,
    intentId: input.refType === 'TRANSFER' ? input.refId : null,
    refId: input.refId,
    suiTxDigest: input.suiTxDigest ?? null,
    postings: [
      { account: customerAccount(input.orgId, subject), currency, amountMinor: signed },
      { account: contraAccount(input.refType), currency, amountMinor: -signed },
    ],
  });

  return {
    id,
    orgId: input.orgId,
    subject,
    direction: input.direction,
    amountMinor: input.amountMinor,
    balanceAfterMinor: await accountBalanceMinor(db, input.orgId, subject, currency),
    refType: input.refType,
    refId: input.refId,
    suiTxDigest: input.suiTxDigest,
    createdAt: new Date().toISOString(),
  };
}

/**
 * What the account may spend.
 *
 * The negation is the liability convention above, not a bug: the customer's
 * postings are negative when they hold funds.
 */
export async function accountBalanceMinor(
  db: Database,
  orgId: string,
  subject = 'self',
  currency = 'USDC',
): Promise<bigint> {
  const [row] = await db
    .select({ total: sql<string | null>`sum(${ledgerPostings.amountMinor})` })
    .from(ledgerPostings)
    .where(
      and(
        eq(ledgerPostings.account, customerAccount(orgId, subject)),
        eq(ledgerPostings.currency, currency),
      ),
    );
  return -BigInt(row?.total ?? 0);
}

/**
 * One account's movements, newest first.
 *
 * The running balance is walked BACKWARDS from the current balance rather than
 * forwards from zero. Forwards would be wrong the moment a limit is applied:
 * the oldest row in the page is not the oldest row in the account, so a
 * forward total would start from a balance the account never had.
 */
export async function listEntriesFor(
  db: Database,
  orgId: string,
  limit = 100,
  subject = 'self',
  currency = 'USDC',
): Promise<LedgerEntryRow[]> {
  const rows = await db
    .select({
      journalId: ledgerPostings.journalId,
      amountMinor: ledgerPostings.amountMinor,
      kind: journalEntries.kind,
      refId: journalEntries.refId,
      suiTxDigest: journalEntries.suiTxDigest,
      createdAt: ledgerPostings.createdAt,
    })
    .from(ledgerPostings)
    .innerJoin(journalEntries, eq(journalEntries.id, ledgerPostings.journalId))
    .where(
      and(
        eq(ledgerPostings.account, customerAccount(orgId, subject)),
        eq(ledgerPostings.currency, currency),
      ),
    )
    .orderBy(desc(ledgerPostings.createdAt))
    .limit(limit);

  let running = await accountBalanceMinor(db, orgId, subject, currency);
  return rows.map((row) => {
    // A negative posting is money arriving (credit to a liability).
    const credit = row.amountMinor < 0n;
    const amountMinor = credit ? -row.amountMinor : row.amountMinor;
    const entry: LedgerEntryRow = {
      id: row.journalId,
      orgId,
      subject,
      direction: credit ? 'CREDIT' : 'DEBIT',
      amountMinor,
      balanceAfterMinor: running,
      refType: row.kind,
      refId: row.refId ?? row.journalId,
      suiTxDigest: row.suiTxDigest ?? undefined,
      createdAt: row.createdAt.toISOString(),
    };
    running = credit ? running - amountMinor : running + amountMinor;
    return entry;
  });
}

/**
 * Every movement since a moment. No limit, deliberately.
 *
 * The daily-spend ceiling is computed from this. A paged read would be a
 * ceiling that quietly stops binding on a busy account: once today's earlier
 * debits fall off the end of the page, the spend total drops and the account
 * gets its daily budget back. A limit is the wrong shape for a limit check.
 */
export async function listEntriesSince(
  db: Database,
  orgId: string,
  sinceMs: number,
  subject = 'self',
  currency = 'USDC',
): Promise<LedgerEntryRow[]> {
  const rows = await db
    .select({
      journalId: ledgerPostings.journalId,
      amountMinor: ledgerPostings.amountMinor,
      kind: journalEntries.kind,
      refId: journalEntries.refId,
      suiTxDigest: journalEntries.suiTxDigest,
      createdAt: ledgerPostings.createdAt,
    })
    .from(ledgerPostings)
    .innerJoin(journalEntries, eq(journalEntries.id, ledgerPostings.journalId))
    .where(
      and(
        eq(ledgerPostings.account, customerAccount(orgId, subject)),
        eq(ledgerPostings.currency, currency),
        gte(ledgerPostings.createdAt, new Date(sinceMs)),
      ),
    )
    .orderBy(desc(ledgerPostings.createdAt));

  return rows.map((row) => {
    const credit = row.amountMinor < 0n;
    return {
      id: row.journalId,
      orgId,
      subject,
      direction: credit ? ('CREDIT' as const) : ('DEBIT' as const),
      amountMinor: credit ? -row.amountMinor : row.amountMinor,
      // A window read is for totalling, not for display. The running balance
      // belongs to `listEntriesFor`, which knows where the page sits.
      balanceAfterMinor: 0n,
      refType: row.kind,
      refId: row.refId ?? row.journalId,
      suiTxDigest: row.suiTxDigest ?? undefined,
      createdAt: row.createdAt.toISOString(),
    };
  });
}

export const __testing = { customerAccount, contraAccount };
