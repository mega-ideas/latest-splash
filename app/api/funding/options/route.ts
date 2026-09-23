import { NextResponse } from 'next/server';

import {
  buildFundingSources,
  getEnabledFundingOptions,
  selectionForSource,
  suggestedUsdProvider,
  type FundingSourceId,
} from '@/lib/funding/registry';
import { requireCustomerRequest } from '@/lib/server/customer-auth';
import { accountBalance } from '@/lib/server/ledger-store';
import { readLastUsedFundingSource } from '@/lib/server/funding-sessions';
import { isForeignAccountId, requireSessionAccount } from '@/lib/server/session-account';

export async function GET(request: Request) {
  const auth = await requireCustomerRequest(request);
  if (auth.response) return auth.response;

  const url = new URL(request.url);
  const amountUsd = Number.parseFloat(url.searchParams.get('amountUsd') ?? '0');
  const amountDueMicro = Number.isFinite(amountUsd) && amountUsd > 0 ? Math.round(amountUsd * 1_000_000) : 0;
  // Derived from the session, not the query string — this response discloses a
  // spendable balance, so a client-named account is a balance oracle for any
  // org whose account id you can guess.
  const accountCheck = await requireSessionAccount(auth.session);
  if (accountCheck.response) return accountCheck.response;
  const { accountId: businessAccountId } = accountCheck.account;
  if (isForeignAccountId(url.searchParams.get('businessAccountId'), businessAccountId)) {
    return NextResponse.json({ error: 'businessAccountId does not belong to this organization' }, { status: 403 });
  }
  const registry = getEnabledFundingOptions();
  const heldBalanceMicro = Number(await accountBalance(accountCheck.account.orgId));
  const sources = buildFundingSources({ registry, heldBalanceMicro, amountDueMicro });
  const lastUsedSource = readLastUsedFundingSource(businessAccountId);
  const countryCode = request.headers.get('x-vercel-ip-country')
    ?? request.headers.get('cf-ipcountry')
    ?? request.headers.get('x-country-code');
  const suggestedProvider = suggestedUsdProvider(countryCode, registry);
  const sourceIsEnabled = (source: FundingSourceId | null) => Boolean(source && sources.some((item) => item.id === source && item.enabled));
  const defaultSource = sources.find((source) => source.id === 'SPLASH_BALANCE' && source.enabled)?.id
    ?? (sourceIsEnabled(lastUsedSource) ? lastUsedSource : null)
    ?? sources.find((source) => source.id === 'BANK_USD' && source.enabled)?.id
    ?? sources.find((source) => source.enabled)?.id
    ?? null;

  return NextResponse.json({
    ...registry,
    sources,
    defaultSource,
    defaultSelection: defaultSource ? selectionForSource(defaultSource, registry, suggestedProvider) : null,
    heldBalanceMicro,
    heldBalanceUsdc: (heldBalanceMicro / 1_000_000).toFixed(2),
    lastUsedSource,
    businessAccountId,
    suggestedUsdProvider: suggestedProvider,
    countryCode: countryCode?.toUpperCase() ?? null,
    demoMode: process.env.NODE_ENV !== 'production' || process.env.USE_MOCK_APIS === 'true' || process.env.NEXT_PUBLIC_DEMO_MODE === 'true',
  });
}
