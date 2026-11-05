import { NextResponse } from 'next/server';

import { resolveAuthorityForSession } from '@/lib/auth/authority';
import { canAskForWithdrawal } from '@/lib/payouts/withdrawal-rules';
import { requireCustomerRequest } from '@/lib/server/customer-auth';
import { readRecipient, removeRecipient } from '@/lib/server/recipients-store';
import { revokeRecipientOwnership, walletDeliveryGate } from '@/lib/server/wallet-recipients';
import { recipientsDb } from '@/lib/server/wallet-recipients-deps';
import { requireSessionAccount } from '@/lib/server/session-account';

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireCustomerRequest(request);
  if (auth.response) return auth.response;

  // Being signed in is not the same as owning this beneficiary. The delete
  // used to take an id alone, so any authenticated user could destroy any
  // tenant's beneficiary record by guessing or replaying one.
  const accountCheck = await requireSessionAccount(auth.session);
  if (accountCheck.response) return accountCheck.response;

  // Owners and staff manage recipients, not every member (the same roles as
  // saving one, lib/server/wallet-recipients-deps.ts recipientRoute).
  let authority: Awaited<ReturnType<typeof resolveAuthorityForSession>>;
  try {
    authority = await resolveAuthorityForSession(auth.session);
  } catch {
    return NextResponse.json({ error: 'no membership' }, { status: 403 });
  }
  if (authority.orgId !== accountCheck.account.orgId || !canAskForWithdrawal(authority.role)) {
    return NextResponse.json({ error: 'Only an owner or a staff member can remove the business’s recipients.' }, { status: 403 });
  }

  const { id } = await params;
  // A wallet the supplier holds takes its ownership proof with it (v2 §4.7):
  // the proof also backs a WALLET tag on the spending rules, and a request
  // still collecting signatures for that tag is cancelled. So removing a
  // wallet that is payable (a proven wallet, a confirmed exchange account:
  // what a SpendPolicy may tag) is an owner's call, as withdrawing a proof is.
  const db = await recipientsDb();
  if (db) {
    const existing = await readRecipient(accountCheck.account.orgId, id);
    const kind = existing?.delivery?.deliveryKind;
    if (existing?.walletAddress && (kind === 'SELF_CUSTODY' || kind === 'EXCHANGE') && authority.role !== 'OWNER') {
      const payable = (await walletDeliveryGate(db, accountCheck.account.orgId, existing.walletAddress, kind === 'SELF_CUSTODY' ? 1 : 2)) === null;
      if (payable || existing.delivery?.ownershipStatus === 'proven') {
        return NextResponse.json({ error: 'Only an owner can remove a recipient that can be paid. Ask an owner to remove it.' }, { status: 403 });
      }
    }
    if (kind === 'SELF_CUSTODY') {
      await revokeRecipientOwnership({ db, orgId: accountCheck.account.orgId, now: () => new Date() }, { recipientId: id });
    }
  }
  // 404 for both "does not exist" and "not yours". A 403 on the second would
  // confirm which ids exist, which is how a tenant gets enumerated.
  if (!await removeRecipient(accountCheck.account.orgId, id)) {
    return NextResponse.json({ error: 'Recipient not found' }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
