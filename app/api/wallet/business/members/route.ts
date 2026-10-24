import { NextResponse } from 'next/server';
import { isValidSuiAddress, normalizeSuiAddress } from '@mysten/sui/utils';

import { changeWalletMembership, currentWalletMembers } from '@/lib/server/business-wallet';
import { readJsonBody } from '@/lib/server/http';
import { orgWalletMembers } from '@/lib/server/wallet-deps';
import { asResponse, limitWalletRequests, NO_STORE, requireOwner, walletRoute } from '@/lib/server/wallet-route';

export const dynamic = 'force-dynamic';

const CHANGES = ['add_owner', 'remove_owner', 'set_recovery_party'] as const;
type Change = (typeof CHANGES)[number];

/**
 * Owner membership on the BusinessAccount, signed by the business wallet's
 * quorum (Phase 1 R4: wallet-only once a wallet is registered).
 *
 * POST { change, member }        add_owner / remove_owner for an owner of
 *                                this business, by their membership in this
 *                                org: their passkey address here is used.
 * POST { change, address }       remove_owner or set_recovery_party for an
 *                                address (a former owner with no passkey
 *                                here, or the recovery party).
 *
 * A member named who is not in this org reads as absent (404).
 */
export async function POST(request: Request) {
  const gate = await walletRoute(request);
  if (gate.response) return gate.response;
  const route = gate.route;
  const notOwner = requireOwner(route, 'change the business owners');
  if (notOwner) return notOwner;
  const limited = await limitWalletRequests(route);
  if (limited) return limited;
  const { orgId, authority, ctx, db } = route;

  const body = await readJsonBody(request);
  const change = String(body.change ?? '') as Change;
  if (!CHANGES.includes(change)) return NextResponse.json({ error: 'Unknown change.' }, { status: 400, headers: NO_STORE });

  const current = await currentWalletMembers(ctx, db, orgId);
  if (!current.ok) return asResponse(current);

  let address: string;
  if (body.member !== undefined) {
    const { candidates } = await orgWalletMembers(db, orgId, current.account);
    const member = candidates.find((c) => c.userId === String(body.member));
    if (!member) return NextResponse.json({ error: 'No such owner with a passkey in this business.' }, { status: 404, headers: NO_STORE });
    address = member.address;
  } else {
    const raw = String(body.address ?? '');
    if (change === 'add_owner') return NextResponse.json({ error: 'An owner is added by their membership in this business.' }, { status: 400, headers: NO_STORE });
    // normalizeSuiAddress('') is the zero address, which is "valid": check the input first.
    if (!/^0x[0-9a-fA-F]{1,64}$/.test(raw.trim()) || !isValidSuiAddress(normalizeSuiAddress(raw.trim())) || /^0x0+$/.test(raw.trim())) {
      return NextResponse.json({ error: 'That is not a Sui address.' }, { status: 400, headers: NO_STORE });
    }
    address = normalizeSuiAddress(raw.trim());
  }
  const result = await changeWalletMembership(ctx, { orgId, requestedBy: authority.userId, wallet: current.members, change, address });
  return asResponse(result, result.ok ? { request: result.request } : undefined);
}
