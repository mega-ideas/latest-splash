import { sql } from 'drizzle-orm';

import { journalEntries, ledgerPostings } from '../db/schema.ts';
import type { Database } from '../db/client.ts';

/**
 * W1 — double-entry ledger writer.
 *
 * Every money movement flows through postJournal(): a journal entry plus
 * postings that MUST sum to zero per currency (debits positive, credits
 * negative, bigint minor units). The write happens inside the transaction
 * the caller already opened for its state change — money and state can
 * never diverge because they commit or roll back together.
 */

export type PostingInput = {
  account: string;
  currency: string;
  /** Signed minor units — debit positive, credit negative. */
  amountMinor: bigint;
};

export type JournalInput = {
  id: string;
  orgId?: string | null;
  kind: string;
  intentId?: string | null;
  /** What the movement refers to: sweep job, funding session, intent. */
  refId?: string | null;
  /** Chain evidence, where the movement had any. */
  suiTxDigest?: string | null;
  description?: string | null;
  postings: PostingInput[];
};

export class UnbalancedJournalError extends Error {
  constructor(currency: string, sum: bigint) {
    super(`Journal postings do not balance for ${currency}: sum ${sum} (must be 0)`);
    this.name = 'UnbalancedJournalError';
  }
}

/** Throws unless every currency's postings sum to exactly zero. */
export function assertBalanced(postings: PostingInput[]): void {
  if (postings.length < 2) {
    throw new UnbalancedJournalError(postings[0]?.currency ?? 'NONE', postings[0]?.amountMinor ?? BigInt(0));
  }
  const sums = new Map<string, bigint>();
  for (const posting of postings) {
    sums.set(posting.currency, (sums.get(posting.currency) ?? BigInt(0)) + posting.amountMinor);
  }
  for (const [currency, sum] of sums) {
    if (sum !== BigInt(0)) throw new UnbalancedJournalError(currency, sum);
  }
}

/**
 * Write one balanced journal entry + postings. Pass the caller's
 * transaction handle so ledger and state share one commit.
 */
export async function postJournal(tx: Database, input: JournalInput): Promise<void> {
  assertBalanced(input.postings);

  await tx.insert(journalEntries).values({
    id: input.id,
    orgId: input.orgId ?? null,
    kind: input.kind,
    intentId: input.intentId ?? null,
    refId: input.refId ?? null,
    suiTxDigest: input.suiTxDigest ?? null,
    description: input.description ?? null,
  });

  await tx.insert(ledgerPostings).values(
    input.postings.map((posting, index) => ({
      id: `${input.id}_p${index}`,
      journalId: input.id,
      account: posting.account,
      currency: posting.currency,
      amountMinor: posting.amountMinor,
    })),
  );
}

/**
 * Global ledger invariant: Σ postings = 0 for every (journal, currency).
 * Returns offending journal ids (empty array = healthy ledger).
 */
export async function findUnbalancedJournals(db: Database): Promise<string[]> {
  const rows = await db
    .select({
      journalId: ledgerPostings.journalId,
      currency: ledgerPostings.currency,
      total: sql<string>`sum(${ledgerPostings.amountMinor})`,
    })
    .from(ledgerPostings)
    .groupBy(ledgerPostings.journalId, ledgerPostings.currency)
    .having(sql`sum(${ledgerPostings.amountMinor}) <> 0`);

  return rows.map((row) => row.journalId);
}
