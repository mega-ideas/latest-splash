import { NextResponse } from 'next/server';

import { requireCustomerRequest } from '@/lib/server/customer-auth';
import { readRecipient, removeRecipient } from '@/lib/server/recipients-store';
import { revokeRecipientOwnership } from '@/lib/server/wallet-recipients';
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

  const { id } = await params;
  // A wallet the supplier holds takes its ownership proof with it (v2 §4.7):
  // the proof also backs a WALLET tag on the spending rules, and a request
  // still collecting signatures for that tag is cancelled.
  const db = await recipientsDb();
  if (db) {
    const existing = await readRecipient(accountCheck.account.orgId, id);
    if (existing?.delivery?.deliveryKind === 'SELF_CUSTODY') {
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
