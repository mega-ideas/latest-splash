/**
 * 0xWal personalized suggestions — drawn from MemWal behavioral memory (with
 * grounded defaults). Powers the swipeable recommendation cards on the copilot
 * page. Suggest-only: each card links to a screen where the user authorizes.
 */

import { NextResponse } from 'next/server';

import { requireCustomerRequest } from '@/lib/server/customer-auth';
import { RATE_LIMITS, clientIp, enforceRateLimit } from '@/lib/server/rate-limit';
import { getCopilotSuggestions } from '@/lib/server/copilot';
import { listInvoicesFor } from '@/lib/server/invoices-store';
import { requireSessionAccount } from '@/lib/server/session-account';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const auth = await requireCustomerRequest(request);
  if (auth.response) return auth.response;

  const limited =
    (await enforceRateLimit({ rule: RATE_LIMITS.copilotUser, key: auth.session.email })) ??
    (await enforceRateLimit({ rule: RATE_LIMITS.copilotIp, key: clientIp(request) }));
  if (limited) return limited;
  // Suggestions are drawn from the caller's OWN invoices. Unscoped, a batch
  // suggestion would have named another tenant's invoice ids in
  // `suggestedAction` — and the card links to a screen that acts on them.
  const accountCheck = await requireSessionAccount(auth.session);
  if (accountCheck.response) return accountCheck.response;

  const user = new URL(request.url).searchParams.get('user') ?? 'patterns';
  const suggestions = await getCopilotSuggestions(user);
  const openInvoices = (await listInvoicesFor(accountCheck.account.orgId))
    .filter((invoice) => invoice.status !== 'paid' && invoice.status !== 'settled');
  const invoicesByCurrency = openInvoices.reduce<Record<string, typeof openInvoices>>((groups, invoice) => {
    (groups[invoice.targetCurrency] ??= []).push(invoice);
    return groups;
  }, {});
  const batchSuggestions = Object.entries(invoicesByCurrency)
    .filter(([, invoices]) => invoices.length >= 2)
    .map(([currency, invoices]) => ({
      suggestionId: `invoice_batch_${currency}`,
      type: 'batch' as const,
      title: `Batch ${invoices.length} open ${currency} invoices`,
      description: `These invoices share the USD to ${currency} corridor. Drafting one batch could save about $${((invoices.length - 1) * 23.5).toFixed(0)} in repeated settlement costs.`,
      confidence: 0.92,
      requiresAuth: true,
      suggestedAction: `batch:${currency}:${invoices.map((invoice) => invoice.id).join(',')}`,
    }));

  return NextResponse.json({ suggestions: [...batchSuggestions, ...suggestions].slice(0, 5) });
}
