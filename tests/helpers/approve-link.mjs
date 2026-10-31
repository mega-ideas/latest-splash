/**
 * A world with a business wallet registration waiting on two of three owners,
 * for the approve-link tests: the real request (its bytes decoded, its hash
 * and id) and the stored row the notifier is handed.
 */
import { fromBase64 } from '@mysten/sui/utils';

import { world } from '../fixtures/wallet-world.mjs';
import { startBusinessWallet } from '../../lib/server/business-wallet.ts';
import { signingInbox, submitPartialSignature } from '../../lib/server/wallet-signing.ts';
import { readSigningRequest } from '../../lib/server/wallet-signing-store.ts';

export async function sign(passkey, view) {
  return (await passkey.keypair.signTransaction(fromBase64(view.transactionBytes))).signature;
}

export async function nominateAndOpen() {
  const w = await world();
  const started = await startBusinessWallet(w.ctx, {
    orgId: 'acme',
    requestedBy: 'u-founder',
    founder: { userId: 'u-founder', passkeyPublicKey: w.keys.founder.publicKey },
    owners: w.owners,
  });
  if (!started.ok) throw new Error(JSON.stringify(started));
  const done = await submitPartialSignature(w.signing, {
    orgId: 'acme',
    userId: 'u-founder',
    id: started.request.id,
    signature: await sign(w.keys.founder, started.request),
    digest: started.request.digest,
  });
  if (!done.ok) throw new Error(JSON.stringify(done));
  const [register] = await signingInbox(w.signing, { orgId: 'acme', userId: 'u-two' });
  const stored = await readSigningRequest(w.db, 'acme', register.id);
  return { w, register, stored };
}
