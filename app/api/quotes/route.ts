import { NextResponse } from 'next/server';

import { FeeConfigUnavailableError } from '@/lib/fees/fee-config';
import { requireCustomerRequest } from '@/lib/server/customer-auth';
import { readJsonBody } from '@/lib/server/http';
import { calculateQuote } from '@/lib/server/quote';

/**
 * A quote for a local-currency payout: A1 §4's { splashFee, partnerFee,
 * totalDebitMinor, maxFeeMinor } with the exchange rate and what the
 * supplier receives (lib/server/quote.ts). When Splash's fee cannot be read
 * from the FeeConfig it answers 503 and quotes nothing.
 */
export async function POST(request: Request) {
  const auth = await requireCustomerRequest(request);
  if (auth.response) return auth.response;

  const body = await readJsonBody(request);
  const fromAmountSen = body.fromAmount === undefined
    ? Math.round(Number(body.amount ?? 0) * 100)
    : Math.round(Number(body.fromAmount ?? 0));
  const targetCurrency = String(body.targetCurrency ?? 'PHP');
  const recipientId = typeof body.recipientId === 'string' ? body.recipientId : undefined;
  const feeTier = body.fundingFeeTier === 'DISCOUNT' ? 'DISCOUNT' : 'STANDARD';

  if (!Number.isSafeInteger(fromAmountSen) || fromAmountSen <= 0) {
    return NextResponse.json({ error: 'A positive source amount is required' }, { status: 400 });
  }

  try {
    // No business discount is read here: the session names no on-chain
    // account, and quoting without a discount can only over-quote, never
    // under (the chain returns the unused max_fee to the business wallet).
    // The authorize route quotes again with the account it resolves.
    const quote = await calculateQuote(fromAmountSen, recipientId, targetCurrency, feeTier);
    return NextResponse.json(quote);
  } catch (error) {
    if (error instanceof FeeConfigUnavailableError) {
      return NextResponse.json(
        { error: "Splash's fee cannot be read from the network right now, so there is no quote. Nothing was sent; try again shortly.", code: 'fee_unavailable' },
        { status: 503 },
      );
    }
    throw error;
  }
}
