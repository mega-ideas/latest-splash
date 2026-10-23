import { and, eq, isNull } from 'drizzle-orm';
import { normalizeSuiAddress } from '@mysten/sui/utils';

import { getDb } from '@/lib/db/client';
import { passkeyCredentials, walletIdentities } from '@/lib/db/schema';

/**
 * WS3. Is `address` one of this user's own signers — an active Splash
 * passkey, or a zkLogin wallet identity?
 *
 * The chain already refuses a signer outside the account's owner and approver
 * sets. This is the other half: a signed-in member may only ask Splash to
 * compose a service-order signature for an address that is THEIRS, so the
 * record of who ordered and who approved names the person, not merely an
 * address someone typed. Fails closed: with no database there are no
 * enrolled signers, so nothing is composed.
 */
export async function signerBelongsToUser(userId: string, address: string): Promise<boolean> {
  if (!process.env.DATABASE_URL) return false;
  const suiAddress = normalizeSuiAddress(address);
  const db = getDb();
  const [passkey] = await db
    .select({ id: passkeyCredentials.id })
    .from(passkeyCredentials)
    .where(and(
      eq(passkeyCredentials.userId, userId),
      eq(passkeyCredentials.suiAddress, suiAddress),
      isNull(passkeyCredentials.revokedAt),
    ))
    .limit(1);
  if (passkey) return true;
  const [identity] = await db
    .select({ id: walletIdentities.id })
    .from(walletIdentities)
    .where(and(eq(walletIdentities.userId, userId), eq(walletIdentities.suiAddress, suiAddress)))
    .limit(1);
  return Boolean(identity);
}

/** This user's signers the browser may offer: their passkeys, with what signing needs. */
export async function listUserPasskeySigners(userId: string): Promise<Array<{ address: string; publicKey: string; rpId: string }>> {
  if (!process.env.DATABASE_URL) return [];
  const rows = await getDb()
    .select({ address: passkeyCredentials.suiAddress, publicKey: passkeyCredentials.publicKey, rpId: passkeyCredentials.rpId })
    .from(passkeyCredentials)
    .where(and(eq(passkeyCredentials.userId, userId), isNull(passkeyCredentials.revokedAt)));
  return rows;
}
