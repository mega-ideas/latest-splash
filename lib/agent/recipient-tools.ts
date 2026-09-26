/**
 * The tools that let Zeke work with real beneficiaries.
 *
 * ─── Why sending is restricted to saved recipients ──────────────────────────
 *
 * "Send 10k to Mabuhay" is a sentence, and a sentence is not a payment
 * instruction. It carries no account number, no bank, no country, no
 * travel-rule record — and an assistant that resolves it by guessing, or by
 * asking the user to type an account number into a chat box, has invented a
 * beneficiary that nobody screened.
 *
 * So the rule is: Zeke can only propose a payment to a beneficiary that is
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
import type { KybLifecycleState } from '@/lib/compliance/kyb-state';
import { laneAccess } from '@/lib/payments/stablecoin-lane';
import { walletSendable } from '@/lib/server/wallet-screening';
import { launchScope, laneInScope, LAUNCH_SCOPE_WHY } from '@/lib/server/launch-scope';
import { zekeLaneState } from './zeke-lane-guard';

export type RecipientMatch = {
  id: string;
  name: string;
  country: string;
  bank: string;
  tier: string;
  /** BANK: a local-currency payout through a corridor partner. WALLET: USDC on
   *  Sui, signed by the business in its own wallet on the Send screen. */
  payoutMethod: 'BANK' | 'WALLET';
  /** WALLET only: the address, shortened — enough to confirm, not to copy. */
  wallet?: string;
  /** Whether this beneficiary can actually be paid, and if not, why. */
  payable: boolean;
  blockedBecause?: string;
  /** WALLET only: Zeke cannot sign a wallet transfer; this says who does. */
  howToPay?: string;
};

interface DescribeContext {
  state: KybLifecycleState;
}

function shortAddress(address: string): string {
  return address.length > 14 ? `${address.slice(0, 8)}…${address.slice(-6)}` : address;
}

function describe(record: RecipientRecord, ctx: DescribeContext): RecipientMatch {
  if (record.payoutMethod === 'WALLET') {
    const lane = laneAccess(ctx.state, 'STABLECOIN_WALLET');
    const screen = walletSendable(record.screeningVerdict);
    const blockedBecause = !lane.allowed ? lane.reason : !screen.ok ? screen.reason : undefined;
    return {
      id: record.id,
      name: record.name,
      country: record.country,
      bank: '',
      tier: record.tier,
      payoutMethod: 'WALLET',
      wallet: record.walletAddress ? shortAddress(record.walletAddress) : undefined,
      payable: !blockedBecause,
      blockedBecause,
      howToPay: 'USDC on Sui mainnet. The business approves it with a WhatsApp code and signs it in its own wallet on the Send screen; Zeke cannot send it.',
    };
  }

  // A bank payout is the fiat lane. For a business still in verification it
  // is locked however complete the record is — say that first, because it is
  // the reason that no amount of record-filling fixes.
  // In a USDC-only launch no bank recipient is payable, whatever the
  // verification — and verification is not what would change it.
  if (!laneInScope('FIAT_OUT_LOCAL', launchScope())) {
    return {
      id: record.id,
      name: record.name,
      country: record.country,
      bank: record.bank,
      tier: record.tier,
      payoutMethod: 'BANK',
      payable: false,
      blockedBecause: `${LAUNCH_SCOPE_WHY} Pay a Sui wallet recipient instead.`,
    };
  }
  const fiat = laneAccess(ctx.state, 'FIAT_OUT_LOCAL');
  if (!fiat.allowed) {
    return {
      id: record.id,
      name: record.name,
      country: record.country,
      bank: record.bank,
      tier: record.tier,
      payoutMethod: 'BANK',
      payable: false,
      blockedBecause: fiat.reason,
    };
  }

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
    payoutMethod: 'BANK',
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
  // Sequential, not Promise.all: the local dev database serves one
  // connection, and two reads racing for it wedge it (scripts/dev-db.mjs).
  const saved = await listRecipientsFor(orgId, 500);
  const ctx = await describeContext(orgId);
  const wanted = name.trim().toLowerCase();
  const describeOne = (record: RecipientRecord) => describe(record, ctx);

  const exact = saved.filter((r) => r.name.trim().toLowerCase() === wanted);
  const prefix = saved.filter((r) => r.name.trim().toLowerCase().startsWith(wanted));
  const contains = saved.filter((r) => r.name.trim().toLowerCase().includes(wanted));

  for (const bucket of [exact, prefix, contains]) {
    if (bucket.length === 1) return { status: 'FOUND', match: describeOne(bucket[0]) };
    if (bucket.length > 1) {
      return {
        status: 'AMBIGUOUS',
        candidates: bucket.slice(0, 5).map(describeOne),
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

/** Every saved beneficiary, so Zeke can say who it CAN pay. */
export async function listSavedRecipients(input: unknown): Promise<{
  orgId: string;
  count: number;
  recipients: RecipientMatch[];
}> {
  const { orgId } = (input ?? {}) as { orgId?: string };
  if (!orgId) return { orgId: '', count: 0, recipients: [] };

  const { listRecipientsFor } = await import('@/lib/server/recipients-store');
  const saved = await listRecipientsFor(orgId, 200);
  const ctx = await describeContext(orgId);
  return { orgId, count: saved.length, recipients: saved.map((record) => describe(record, ctx)) };
}

/** The lane state, as the money routes see it. */
async function describeContext(orgId: string): Promise<DescribeContext> {
  return { state: await zekeLaneState(orgId) };
}
