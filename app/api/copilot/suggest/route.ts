/**
 * Zeke personalized suggestions, drawn from the caller's open invoices and
 * MemWal behavioral memory. Powers the suggestion cards on the copilot page.
 * Suggest-only: each card becomes a question for Zeke there, and anything
 * that moves money still goes through a proposal the user approves.
 */

import { NextResponse } from 'next/server';

import { requireCustomerRequest } from '@/lib/server/customer-auth';
import { RATE_LIMITS, clientIp, enforceRateLimit } from '@/lib/server/rate-limit';
import { getCopilotSuggestions, type CopilotSuggestion } from '@/lib/server/copilot';
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

  // Memory cards come from this org's memory only. The org is the session's;
  // the route used to read `?user` from the URL and recall from a namespace
  // every workspace shared, and a card quotes what it recalls word for word.
  const suggestions = await getCopilotSuggestions(accountCheck.account.orgId);
  const openInvoices = (await listInvoicesFor(accountCheck.account.orgId))
    .filter((invoice) => invoice.status !== 'paid' && invoice.status !== 'settled');
  const invoicesByCurrency = openInvoices.reduce<Record<string, typeof openInvoices>>((groups, invoice) => {
    (groups[invoice.targetCurrency] ??= []).push(invoice);
    return groups;
  }, {});
  // A rule, not a measurement: two or more open invoices on one corridor. So
  // the card states that fact and claims nothing else. It used to show 92%
  // confidence and "could save about $<(n - 1) × 23.5>", both invented. It
  // does not say how a batch would settle them either: nothing turns invoices
  // into a batch yet, so the card is a question for Zeke, not a plan.
  const batchSuggestions: CopilotSuggestion[] = Object.entries(invoicesByCurrency)
    .filter(([, invoices]) => invoices.length >= 2)
    .map(([currency, invoices]) => ({
      suggestionId: `invoice_batch_${currency}`,
      type: 'batch' as const,
      title: `Batch ${invoices.length} open ${currency} invoices`,
      description: `${invoices.length} open invoices are on the USD to ${currency} corridor.`,
      confidence: null,
      requiresAuth: true,
      suggestedAction: `batch:${currency}:${invoices.map((invoice) => invoice.id).join(',')}`,
    }));

  return NextResponse.json({ suggestions: [...batchSuggestions, ...suggestions].slice(0, 5) });
}
