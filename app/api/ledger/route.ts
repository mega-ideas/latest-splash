import { NextResponse } from 'next/server';

import { requireCustomerRequest } from '@/lib/server/customer-auth';
import { divRound, formatMinor } from '@/lib/money';
import { moneyJson } from '@/lib/server/json';
import { accountBalance, listMovements } from '@/lib/server/ledger-store';
import { isForeignAccountId, requireSessionAccount } from '@/lib/server/session-account';

export async function GET(request: Request) {
  const auth = await requireCustomerRequest(request);
  if (auth.response) return auth.response;

  // Previously `accountId` came from the query string and an omitted value made
  // `listLedgerEntries(undefined)` return EVERY account's entries — the exact
  // enumeration primitive that turns a guessed account id into a targeted
  // debit. The account is now derived from the session and a query-supplied id
  // may only name the caller's own account.
  const accountCheck = await requireSessionAccount(auth.session);
  if (accountCheck.response) return accountCheck.response;
  const { accountId } = accountCheck.account;
  const requested = new URL(request.url).searchParams.get('accountId');
  if (isForeignAccountId(requested, accountId)) {
    return NextResponse.json({ error: 'accountId does not belong to this organization' }, { status: 403 });
  }

  const entries = await listMovements(accountCheck.account.orgId);
  const balanceMinor = await accountBalance(accountCheck.account.orgId);
  // `moneyJson` because these are bigints now: JSON.stringify throws on one,
  // and a Number() would lose precision above 2^53 rather than saying so.
  return moneyJson({
    accountId,
    entries,
    balanceMicro: balanceMinor,
    // Micro-USDC to a two-decimal display figure. `floor`, not `trunc`: on a
    // negative balance trunc rounds toward zero and would show less debt than
    // there is.
    balanceUsdc: formatMinor(divRound(balanceMinor, 10_000n, 'floor'), 2),
  });
}
