/**
 * Saved wallet recipients for tests (v2 §4.7): a wallet payment goes only to
 * a saved recipient of its kind, a wallet the supplier holds only once its
 * ownership proof is recorded. Rows are written directly; nothing is signed.
 */
import { randomUUID } from 'node:crypto';

import { normalizeSuiAddress } from '@mysten/sui/utils';

import * as schema from '../../lib/db/schema.ts';
import { recordOwnershipProof } from '../../lib/server/ownership-proofs.ts';

/**
 * kind 'SELF_CUSTODY' (proven unless `proven: false`) or 'EXCHANGE' (at
 * `exchange`, default pdax). Returns the recipient id.
 */
export async function saveWalletRecipient(db, { orgId = 'acme', address, kind = 'SELF_CUSTODY', exchange = 'pdax', proven = true, name = 'Dela Cruz Trading Corp', now = new Date() }) {
  const id = `rcp_${randomUUID()}`;
  const a = normalizeSuiAddress(address);
  await db.insert(schema.suppliers).values({
    id,
    orgId,
    name,
    country: 'PH',
    legalName: name,
    registrationNumber: 'CS201912345',
    addressLine1: '1 Ayala Ave',
    addressCity: 'Makati',
    addressCountry: 'PH',
    beneficiaryType: 'BUSINESS',
    tier: 'PAYOUT_ONLY',
    payoutMethod: 'WALLET',
    walletAddress: a,
    walletProvider: kind === 'SELF_CUSTODY' ? 'SLUSH' : null,
    deliveryKind: kind,
    exchangeId: kind === 'EXCHANGE' ? exchange : null,
    depositNetwork: kind === 'EXCHANGE' ? 'SUI' : null,
    ownershipStatus: kind === 'SELF_CUSTODY' ? (proven ? 'proven' : 'unproven') : null,
  });
  if (kind === 'SELF_CUSTODY' && proven) {
    await recordOwnershipProof(db, { orgId, address: a, method: 'sui_personal_message', evidence: `test proof ${id}`, now });
  }
  return id;
}
