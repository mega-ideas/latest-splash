/**
 * What every batch route shares (v2 brief 5.6): a service refusal as the
 * response every wallet route answers with, and a fee the chain cannot give as
 * "no quote, nothing sent". Never reads an org, an account or a role from the
 * request: the gate (batchRoute) takes them from the session.
 */
import 'server-only';

import { NextResponse } from 'next/server';

import { FeeConfigUnavailableError } from '@/lib/fees/fee-config';
import type { BatchFailure } from '@/lib/server/wallet-batches';
import { NO_STORE } from '@/lib/server/wallet-route';

export function batchRefusal(result: BatchFailure): Response {
  const { ok, status, ...rest } = result;
  void ok;
  return NextResponse.json(rest, { status, headers: NO_STORE });
}

/** Runs a batch service call; a fee schedule that cannot be read is a 503, not a guess. */
export async function withFeeGuard(run: () => Promise<Response>): Promise<Response> {
  try {
    return await run();
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
