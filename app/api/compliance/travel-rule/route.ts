import { NextResponse } from 'next/server';

import { corridorRule, missingTravelRuleFields, schemeLabel } from '@/lib/compliance/travel-rule';
import type { BeneficiaryRecord, PaymentContext } from '@/lib/compliance/travel-rule';
import { requireCustomerRequest } from '@/lib/server/customer-auth';
import { readJsonBody } from '@/lib/server/http';
import { readOriginator } from '@/lib/server/originator';
import { requireSessionAccount } from '@/lib/server/session-account';

/**
 * What this corridor still needs before a payment can be sent.
 *
 * The transfer form asks this instead of hardcoding a field list, so the rules
 * live in exactly one place — `lib/compliance/travel-rule.ts` — and the form,
 * the authorize route and the record a partner receives cannot drift apart.
 * A corridor added there appears in the UI with no UI change.
 *
 * The ORIGINATOR half is resolved server-side from the org's KYB record and is
 * never accepted from the client: it is the payer's own identity, and a form
 * that could supply it is a form that could misstate who sent the money.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const auth = await requireCustomerRequest(request);
  if (auth.response) return auth.response;

  const accountCheck = await requireSessionAccount(auth.session);
  if (accountCheck.response) return accountCheck.response;

  const body = await readJsonBody(request);
  const destinationCountry = String(body.destinationCountry ?? '').trim().toUpperCase();
  const beneficiary = (body.beneficiary ?? {}) as BeneficiaryRecord;
  const payment = (body.payment ?? {}) as PaymentContext;

  const rule = corridorRule(destinationCountry);
  const { originator, complete: originatorComplete, missing: originatorMissing } =
    await readOriginator(accountCheck.account.orgId);

  const missing = missingTravelRuleFields({
    destinationCountry,
    beneficiary,
    originator,
    payment,
  });

  return NextResponse.json({
    corridor: rule
      ? {
          country: rule.country,
          currency: rule.currency,
          note: rule.note,
          requiresBranchCode: rule.requiresBranchCode,
          requiresPurposeCode: rule.requiresPurposeCode,
          requiresAccountNumber: rule.requiresAccountNumber,
          // Labelled here rather than in the component: `schemeLabel` is the
          // one place that knows a GB sort code is not a "bank code".
          schemes: rule.bankIdSchemes.map((scheme) => ({ scheme, label: schemeLabel(scheme) })),
        }
      : null,
    // Split, because they are fixed in different places: the beneficiary half
    // in this form, the originator half in the business profile.
    missing: missing.filter((item) => !item.field.startsWith('originator.')),
    originator: {
      complete: originatorComplete,
      legalName: originator.legalName,
      missing: originatorMissing,
    },
    ready: missing.length === 0,
  });
}
