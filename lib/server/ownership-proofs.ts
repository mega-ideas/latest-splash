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
 * revoked. Nothing here verifies a proof; `recordOwnershipProof` is what
 * §4.7's verifier calls once it has. An exchange deposit address (the
 * EXCHANGE tag) needs no such proof.
 *
 * Every read and write takes the business's org.
 */
import { createHash } from 'node:crypto';

import { and, eq, inArray, isNull } from 'drizzle-orm';
import { normalizeSuiAddress } from '@mysten/sui/utils';

import { walletOwnershipProofs } from '../db/schema.ts';
import type { DrizzleDb } from './wallet-signing-store.ts';

export interface OwnershipGate {
  /** Which of these addresses the business has a live ownership proof for. */
  provenAddresses(orgId: string, addresses: string[]): Promise<string[]>;
}

export function dbOwnershipGate(db: DrizzleDb): OwnershipGate {
  return {
    async provenAddresses(orgId, addresses) {
      const wanted = [...new Set(addresses.map((a) => normalizeSuiAddress(a)))];
      if (wanted.length === 0) return [];
      const rows = await db
        .select({ address: walletOwnershipProofs.address })
        .from(walletOwnershipProofs)
        .where(and(eq(walletOwnershipProofs.orgId, orgId), inArray(walletOwnershipProofs.address, wanted), isNull(walletOwnershipProofs.revokedAt)));
      return rows.map((r) => r.address);
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

/** Withdraw a proof: the address may no longer be tagged WALLET (already-verified recipients stay until the owners remove them). */
export async function revokeOwnershipProof(db: DrizzleDb, input: { orgId: string; address: string; now?: Date }): Promise<boolean> {
  const done = await db
    .update(walletOwnershipProofs)
    .set({ revokedAt: input.now ?? new Date() })
    .where(and(eq(walletOwnershipProofs.orgId, input.orgId), eq(walletOwnershipProofs.address, normalizeSuiAddress(input.address)), isNull(walletOwnershipProofs.revokedAt)))
    .returning({ address: walletOwnershipProofs.address });
  return done.length > 0;
}
