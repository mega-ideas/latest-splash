import { NextResponse } from 'next/server';

import { readJsonBody } from '@/lib/server/http';
import { automaticStatus, pauseAutomatic, resumeAutomatic, setGraceWindow } from '@/lib/server/scheduled-payments';
import { scheduleRoute } from '@/lib/server/scheduled-payments-deps';
import { asResponse, limitWalletReads, NO_STORE, requireOwner } from '@/lib/server/wallet-route';

export const dynamic = 'force-dynamic';

/**
 * Automatic payments for the session's business.
 *
 * GET   the scheduled payer (ready or not, and why not), the allowance as the
 *       network has it now, the daily limit and what was used, and the kill
 *       switch. An owner's.
 * POST  { action: 'pause' | 'resume' }: the kill switch. One owner pauses every
 *       automatic payment for the business, at once; the next automatic run
 *       comes to the owners for approval instead. An owner turns it back on.
 *       { action: 'grace', minutes }: the warning window before the first
 *       automatic payment of a run, in whole minutes from 0 to 60 (10 by
 *       default). An owner's own change, in force at once.
 */
export async function GET(request: Request) {
  const gate = await scheduleRoute(request);
  if (gate.response) return gate.response;
  const denied = requireOwner(gate.route, 'see the settings for automatic payments');
  if (denied) return denied;
  const limited = await limitWalletReads(gate.route.authority.userId);
  if (limited) return limited;
  return NextResponse.json({ automatic: await automaticStatus(gate.deps) }, { headers: NO_STORE });
}

export async function POST(request: Request) {
  const gate = await scheduleRoute(request);
  if (gate.response) return gate.response;
  const body = await readJsonBody(request);
  if (body.action === 'grace') {
    const set = await setGraceWindow(gate.deps, gate.actor, body.minutes);
    return set.ok ? NextResponse.json({ graceMinutes: set.graceMinutes }, { headers: NO_STORE }) : asResponse(set);
  }
  if (body.action !== 'pause' && body.action !== 'resume') {
    return NextResponse.json({ error: 'Say whether to pause, resume or set the warning window.', code: 'bad_action' }, { status: 400, headers: NO_STORE });
  }
  const result = body.action === 'pause' ? await pauseAutomatic(gate.deps, gate.actor) : await resumeAutomatic(gate.deps, gate.actor);
  return result.ok ? NextResponse.json({ paused: result.paused }, { headers: NO_STORE }) : asResponse(result);
}
