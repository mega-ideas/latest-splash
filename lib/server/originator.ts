/**
 * The payer's own half of the travel rule.
 *
 * FATF R.16 has two halves. Migration 0006 gave `suppliers` the whole
 * beneficiary side — legal identity, address, bank routing, screening — and
 * gave the originator nothing, so a partner asking us to produce a complete
 * record for a payment we sent could not be answered however carefully the
 * beneficiary had been filled in. Migration 0012 gives the org its own columns
 * and this reads them.
 *
 * ─── Why the transfer form does not ask for this ────────────────────────────
 *
 * These are facts about the payer, established once at KYB, identical on every
 * payment they ever make. Asking an operator to retype their own registered
 * address into a transfer form is how you get eight spellings of one address
 * and a travel-rule record that contradicts the KYB file it should match.
 *
 * So the form READS this and, when it is incomplete, says so as a business
 * profile problem with a link to fix it — not as ten more empty boxes above
 * the beneficiary.
 */
import 'server-only';

import { eq } from 'drizzle-orm';

import type { OriginatorRecord } from '@/lib/compliance/travel-rule';
import { organizations } from '@/lib/db/schema';

export type OriginatorState = {
  originator: OriginatorRecord;
  /** True when R.16's originator half is satisfiable for this org. */
  complete: boolean;
  /** What is still missing, in the operator's words. */
  missing: Array<{ field: string; label: string; because: string }>;
};

const trimmed = (value: string | null | undefined): string | undefined => {
  const text = (value ?? '').trim();
  return text.length > 0 ? text : undefined;
};

/**
 * Read the originator for an org.
 *
 * Returns an EMPTY record rather than throwing when there is no database or no
 * row. The caller's job is to tell the operator their profile is incomplete;
 * a thrown error would turn a fixable form state into a broken page.
 */
export async function readOriginator(orgId: string): Promise<OriginatorState> {
  let row: {
    legalName: string | null;
    name: string | null;
    registrationNumber: string | null;
    addressLine1: string | null;
    addressCity: string | null;
    addressCountry: string | null;
    suiBusinessAccountId: string | null;
  } | null = null;

  if (process.env.DATABASE_URL) {
    try {
      const { getDb } = await import('@/lib/db/client');
      const db = getDb();
      const rows = await db
        .select({
          legalName: organizations.legalName,
          name: organizations.name,
          registrationNumber: organizations.registrationNumber,
          addressLine1: organizations.addressLine1,
          addressCity: organizations.addressCity,
          addressCountry: organizations.addressCountry,
          suiBusinessAccountId: organizations.suiBusinessAccountId,
        })
        .from(organizations)
        .where(eq(organizations.id, orgId))
        .limit(1);
      row = rows[0] ?? null;
    } catch (error) {
      console.warn('[originator] could not read the org profile', (error as Error)?.message);
    }
  }

  const originator: OriginatorRecord = {
    // The REGISTERED name, falling back to the trading name. A travel-rule
    // record naming "Acme" where the register says "Acme Trading Sdn Bhd" is
    // the kind of near-miss that stalls a payment at the receiving bank.
    legalName: trimmed(row?.legalName) ?? trimmed(row?.name) ?? null,
    registrationNumber: trimmed(row?.registrationNumber) ?? null,
    addressLine1: trimmed(row?.addressLine1) ?? null,
    addressCity: trimmed(row?.addressCity) ?? null,
    addressCountry: trimmed(row?.addressCountry) ?? null,
    // R.16 accepts an account number OR a unique transaction reference. The
    // org id is a stable, unique reference we always have.
    accountReference: trimmed(row?.suiBusinessAccountId) ?? orgId,
  };

  const missing: OriginatorState['missing'] = [];
  if (!originator.legalName) {
    missing.push({
      field: 'originator.legalName',
      label: 'Your registered legal name',
      because: 'The travel rule requires the sender’s name to accompany the payment.',
    });
  }
  if (!originator.registrationNumber && !originator.addressLine1) {
    missing.push({
      field: 'originator.registrationNumber',
      label: 'Your company registration number or registered address',
      because:
        'The travel rule requires one identifier for the sender beyond a name. ' +
        'Either your registration number or your registered address satisfies it.',
    });
  }

  return { originator, complete: missing.length === 0, missing };
}
