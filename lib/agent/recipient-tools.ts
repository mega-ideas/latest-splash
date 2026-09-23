/**
 * The tools that let 0xWal work with real beneficiaries.
 *
 * ─── Why sending is restricted to saved recipients ──────────────────────────
 *
 * "Send 10k to Mabuhay" is a sentence, and a sentence is not a payment
 * instruction. It carries no account number, no bank, no country, no
 * travel-rule record — and an assistant that resolves it by guessing, or by
 * asking the user to type an account number into a chat box, has invented a
 * beneficiary that nobody screened.
 *
 * So the rule is: 0xWal can only propose a payment to a beneficiary that is
 * ALREADY saved, verified and complete. If the name does not resolve, it says
 * so and asks for the invoice or for the beneficiary to be added properly —
 * through the form, where the corridor's requirements are enforced.
 *
 * This is not a limitation to work around later. The saved-recipient record is
 * where the KYB, the screening verdict and the FATF R.16 fields live. A payment
 * that skips it is a payment nobody can file a travel-rule record for.
 *
 * ─── Why an ambiguous name refuses rather than picks ────────────────────────
 *
 * Two beneficiaries called "Acme" is the normal state of a supplier list. An
 * assistant that picks the first is an assistant that will one day pay the
 * wrong company an amount the user confirmed without re-reading the account
 * number. Ambiguity is answered with the candidates, never resolved silently.
 */
import type { RecipientRecord } from '@/lib/server/operations';

export type RecipientMatch = {
  id: string;
  name: string;
  country: string;
  bank: string;
  tier: string;
  /** Whether this beneficiary can actually be paid, and if not, why. */
  payable: boolean;
  blockedBecause?: string;
};

function describe(record: RecipientRecord): RecipientMatch {
  // A saved beneficiary is not automatically a payable one. The travel-rule
  // half is what a partner files; without it the payment is refused at
  // authorize anyway, and finding that out at the last step is worse than
  // being told here.
  const missing: string[] = [];
  if (!record.travelRule?.legalName) missing.push('legal name');
  if (!record.travelRule?.addressLine1) missing.push('registered address');
  if (!record.travelRule?.bankIdValue) missing.push('bank routing identifier');
  if (!record.travelRule?.bankAccountName) missing.push('account holder name');

  return {
    id: record.id,
    name: record.name,
    country: record.country,
    bank: record.bank,
    tier: record.tier,
    payable: missing.length === 0,
    blockedBecause:
      missing.length > 0
        ? `Their record is missing the ${missing.join(', ')} that this corridor requires.`
        : undefined,
  };
}

export type RecipientLookup =
  | { status: 'FOUND'; match: RecipientMatch }
  | { status: 'AMBIGUOUS'; candidates: RecipientMatch[]; message: string }
  | { status: 'NOT_FOUND'; message: string; savedCount: number };

/**
 * Find the one saved beneficiary this name means.
 *
 * Exact match first, then a unique prefix, then a unique substring. Each step
 * only resolves when it identifies exactly ONE beneficiary; anything else is
 * reported as ambiguous with the candidates.
 */
export async function findSavedRecipient(input: unknown): Promise<RecipientLookup> {
  const { orgId, name } = (input ?? {}) as { orgId?: string; name?: string };
  if (!orgId || !name) {
    return { status: 'NOT_FOUND', message: 'A beneficiary name is required.', savedCount: 0 };
  }

  const { listRecipientsFor } = await import('@/lib/server/recipients-store');
  const saved = await listRecipientsFor(orgId, 500);
  const wanted = name.trim().toLowerCase();

  const exact = saved.filter((r) => r.name.trim().toLowerCase() === wanted);
  const prefix = saved.filter((r) => r.name.trim().toLowerCase().startsWith(wanted));
  const contains = saved.filter((r) => r.name.trim().toLowerCase().includes(wanted));

  for (const bucket of [exact, prefix, contains]) {
    if (bucket.length === 1) return { status: 'FOUND', match: describe(bucket[0]) };
    if (bucket.length > 1) {
      return {
        status: 'AMBIGUOUS',
        candidates: bucket.slice(0, 5).map(describe),
        message:
          `${bucket.length} saved beneficiaries match "${name}". ` +
          'Say which one — paying the wrong company is not something an approval catches.',
      };
    }
  }

  return {
    status: 'NOT_FOUND',
    savedCount: saved.length,
    message:
      `No saved beneficiary matches "${name}". I can only send to beneficiaries that are ` +
      'already saved and complete, because that record is where the KYB, the screening ' +
      'result and the travel-rule details live. Send me their invoice and I will read it, ' +
      'or add them from the Recipients screen.',
  };
}

/** Every saved beneficiary, so 0xWal can say who it CAN pay. */
export async function listSavedRecipients(input: unknown): Promise<{
  orgId: string;
  count: number;
  recipients: RecipientMatch[];
}> {
  const { orgId } = (input ?? {}) as { orgId?: string };
  if (!orgId) return { orgId: '', count: 0, recipients: [] };

  const { listRecipientsFor } = await import('@/lib/server/recipients-store');
  const saved = await listRecipientsFor(orgId, 200);
  return { orgId, count: saved.length, recipients: saved.map(describe) };
}
