import { NextResponse } from 'next/server';

import { FeeConfigUnavailableError } from '@/lib/fees/fee-config';
import { readJsonBody } from '@/lib/server/http';
import { payeeFromBody, quoteTransfer } from '@/lib/server/wallet-transfers';
import { transferRoute } from '@/lib/server/wallet-transfers-deps';
import { limitWalletRequests, NO_STORE, requireWithdrawalRequester } from '@/lib/server/wallet-route';

export const dynamic = 'force-dynamic';

/**
 * POST { payee, amountMinor }: Splash's fee for a payment to a Splash business
 * or a saved wallet or exchange recipient, from the schedule on chain, before
 * anything is made. `maxFeeMinor` is exactly the fee shown: send it back with
 * the payment. Nothing is stored. When the fee cannot be read there is no
 * quote, and nothing can be sent.
 */
export async function POST(request: Request) {
  const gate = await transferRoute(request);
  if (gate.response) return gate.response;
  const asker = requireWithdrawalRequester(gate.route);
  if (asker) return asker;
  const limited = await limitWalletRequests(gate.route);
  if (limited) return limited;
  const body = await readJsonBody(request);
  try {
    const result = await quoteTransfer(gate.deps, { payee: payeeFromBody(body.payee), amountMinor: body.amountMinor });
    if (!result.ok) {
      const { ok, status, ...rest } = result;
      void ok;
      return NextResponse.json(rest, { status, headers: NO_STORE });
    }
    return NextResponse.json({ quote: result.quote }, { headers: NO_STORE });
  } catch (error) {
    if (error instanceof FeeConfigUnavailableError) {
      return NextResponse.json(
        { error: "Splash's fee cannot be read from the network right now, so there is no quote. Nothing was sent; try again shortly.", code: 'fee_unavailable' },
        { status: 503, headers: NO_STORE },
      );
    }
    throw error;
  }
}
