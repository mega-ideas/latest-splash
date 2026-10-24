import { NextResponse } from 'next/server';

import { buildBusinessMultisig } from '@/lib/wallet/business-multisig';
import { readJsonBody } from '@/lib/server/http';
import { orgWalletMembers } from '@/lib/server/wallet-deps';
import { limitWalletRequests, NO_STORE, requireOwner, walletRoute } from '@/lib/server/wallet-route';
import { recordSingleSignerConsent } from '@/lib/server/wallet-signing-store';

export const dynamic = 'force-dynamic';

/**
 * An owner agrees that one person may sign for the business wallet alone
 * (D1: "1-of-1 only if the business explicitly chooses it (owners record
 * that choice)").
 *
 * POST { threshold, wallet }: Splash builds the wallet the current owners'
 * passkeys and this threshold make, refuses unless it is single-signer and
 * is the exact address the owner was shown (`wallet`), and records this
 * owner's consent to that address. The founder can then start it. A new
 * owner, a changed passkey or another threshold is another address, which
 * needs consent again.
 */
export async function POST(request: Request) {
  const gate = await walletRoute(request);
  if (gate.response) return gate.response;
  const route = gate.route;
  const notOwner = requireOwner(route, 'agree to a single-signer wallet');
  if (notOwner) return notOwner;
  const limited = await limitWalletRequests(route);
  if (limited) return limited;
  const { orgId, authority, ctx, db } = route;

  let account;
  try {
    account = await ctx.readAccount();
  } catch {
    return NextResponse.json({ error: 'The business account could not be read from the chain.' }, { status: 502, headers: NO_STORE });
  }
  const { candidates } = await orgWalletMembers(db, orgId, account);
  if (!candidates.some((c) => c.userId === authority.userId)) {
    return NextResponse.json({ error: 'Add a passkey first: only a wallet member can agree to this.' }, { status: 403, headers: NO_STORE });
  }
  const body = await readJsonBody(request);
  let wallet;
  try {
    wallet = buildBusinessMultisig({
      members: candidates.map((c) => ({ userId: c.userId, publicKey: c.publicKey })),
      threshold: Number(body.threshold),
      singleSignerChosen: true,
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'That wallet cannot be built.' }, { status: 400, headers: NO_STORE });
  }
  if (!wallet.singleSigner) {
    return NextResponse.json({ error: 'With this threshold no owner can sign alone, so there is nothing to agree to.' }, { status: 400, headers: NO_STORE });
  }
  if (String(body.wallet ?? '').toLowerCase() !== wallet.address.toLowerCase()) {
    return NextResponse.json({ error: 'The owners or their passkeys changed since you were shown this wallet. Review it again.' }, { status: 409, headers: NO_STORE });
  }
  await recordSingleSignerConsent(db, { orgId, userId: authority.userId, walletAddress: wallet.address });
  return NextResponse.json({ wallet: wallet.address, consented: true }, { headers: NO_STORE });
}
