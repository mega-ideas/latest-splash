/**
 * The gate in front of the WALLET tag (A1 §2.3, v2 §4.2).
 *
 * A recipient a SpendPolicy tags WALLET is charged Splash's wallet fee
 * (0.02%, min 0.25 USDC) and is paid as a self-custody address. D5 allows a
 * self-custody recipient only after the supplier signs an ownership proof
 * (§4.7, which builds the proof flow: a link, the supplier's wallet signing
 * a fixed message with the address, business name, nonce and expiry). This
 * module is the gate the spending rules read: an address is "proven" for a
 * business while a row in `wallet_ownership_proofs` says so and has not been
 * revoked, and (since the §4.7 review) only while the payment gate would pay
 * it: an owner-approved saved recipient with the supplier's details, never
 * Splash's or the business's own address. Nothing here verifies a proof; `recordOwnershipProof` is what
 * §4.7's verifier calls once it has (lib/server/wallet-recipients.ts
 * submitOwnershipProof). An exchange deposit address (the EXCHANGE tag)
 * needs no such proof, but it must be the business's saved exchange
 * account (§4.7): `savedExchanges`.
 *
 * Every read and write takes the business's org.
 */
import { createHash } from 'node:crypto';

import { and, eq, isNull } from 'drizzle-orm';
import { normalizeSuiAddress } from '@mysten/sui/utils';

import { walletOwnershipProofs } from '../db/schema.ts';
import { closeSigningRequest, listSigningRequests, type DrizzleDb } from './wallet-signing-store.ts';

export interface OwnershipGate {
  /** Which of these addresses the business has a live ownership proof for. */
  provenAddresses(orgId: string, addresses: string[]): Promise<string[]>;
  /** Which of these addresses are the business's saved exchange accounts (v2 §4.7): the EXCHANGE tag's gate. */
  savedExchanges(orgId: string, addresses: string[]): Promise<string[]>;
}

/**
 * The live gate. An address is taggable only as the payment gate would pay
 * it (lib/server/wallet-recipients.ts walletDeliveryGate): WALLET a proven,
 * owner-approved wallet the supplier holds, with its details; EXCHANGE a
 * saved, owner-approved exchange account the exchange confirmed. Never an
 * address Splash controls or one of the business's own.
 */
export function dbOwnershipGate(db: DrizzleDb, opts: { splashAddresses?: () => Promise<string[]> } = {}): OwnershipGate {
  return {
    async provenAddresses(orgId, addresses) {
      const { payableForTag } = await import('./wallet-recipients.ts');
      return payableForTag(db, orgId, addresses, 1, opts);
    },
    async savedExchanges(orgId, addresses) {
      const { payableForTag } = await import('./wallet-recipients.ts');
      return payableForTag(db, orgId, addresses, 2, opts);
    },
  };
}

/**
 * Record that a verified ownership proof exists. Called by §4.7's verifier
 * only after the payee's signature over Splash's message has verified; the
 * evidence is kept as a hash.
 */
export async function recordOwnershipProof(
  db: DrizzleDb,
  input: { orgId: string; address: string; method: string; evidence: string; now?: Date },
): Promise<void> {
  const address = normalizeSuiAddress(input.address);
  await db
    .insert(walletOwnershipProofs)
    .values({
      orgId: input.orgId,
      address,
      method: input.method,
      evidenceSha256: createHash('sha256').update(input.evidence).digest('hex'),
      verifiedAt: input.now ?? new Date(),
    })
    .onConflictDoUpdate({
      target: [walletOwnershipProofs.orgId, walletOwnershipProofs.address],
      set: { method: input.method, evidenceSha256: createHash('sha256').update(input.evidence).digest('hex'), verifiedAt: input.now ?? new Date(), revokedAt: null },
    });
}

/**
 * Withdraw a proof: the address may no longer be tagged WALLET (already-
 * verified recipients stay until the owners remove them). A spending-rule
 * request still collecting signatures that would tag it WALLET was allowed
 * on the proof when it opened; it is cancelled now, so the quorum cannot
 * sign a tag the proof no longer backs.
 */
export async function revokeOwnershipProof(db: DrizzleDb, input: { orgId: string; address: string; now?: Date }): Promise<boolean> {
  const now = input.now ?? new Date();
  const address = normalizeSuiAddress(input.address);
  const done = await db
    .update(walletOwnershipProofs)
    .set({ revokedAt: now })
    .where(and(eq(walletOwnershipProofs.orgId, input.orgId), eq(walletOwnershipProofs.address, address), isNull(walletOwnershipProofs.revokedAt)))
    .returning({ address: walletOwnershipProofs.address });
  const waiting = await listSigningRequests(db, input.orgId, ['collecting']);
  for (const r of waiting) {
    if (r.purpose !== 'spend_rule') continue;
    const actions = (r.summary as { description?: { actions?: Array<{ type: string; address?: string; kind?: number }> } } | null)?.description?.actions ?? [];
    if (!actions.some((a) => a.type === 'verify_recipient' && a.kind === WALLET_TAG && a.address && normalizeSuiAddress(a.address) === address)) continue;
    await closeSigningRequest(db, { orgId: input.orgId, id: r.id, status: 'cancelled', from: ['collecting'], error: 'the ownership proof behind a WALLET tag in it was withdrawn', now });
  }
  return done.length > 0;
}

/** spend_policy's WALLET tag (KIND_WALLET). */
const WALLET_TAG = 1;
