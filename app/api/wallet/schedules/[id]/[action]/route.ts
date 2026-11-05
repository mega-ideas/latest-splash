import { NextResponse } from 'next/server';

import { readJsonBody } from '@/lib/server/http';
import { resumeSchedule, skipRun, stopSchedule } from '@/lib/server/scheduled-payments';
import { scheduleRoute } from '@/lib/server/scheduled-payments-deps';
import { asResponse, NO_STORE } from '@/lib/server/wallet-route';

export const dynamic = 'force-dynamic';

/**
 * One click, at once, with no cooldown, on one schedule of the session's own
 * business (another's reads as absent):
 *
 *   POST …/skip    { runId? }  skip the next run, or the named one. A prepared
 *                  run has its approval request withdrawn; an automatic run is
 *                  skipped only while none of its payments has gone out.
 *   POST …/stop    stop the schedule: nothing more starts until it is resumed.
 *   POST …/resume  start a stopped schedule again, from its next time.
 *
 * An owner may do these to any schedule; the Finance lead to “ask me first”
 * ones only.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string; action: string }> }) {
  const gate = await scheduleRoute(request);
  if (gate.response) return gate.response;
  const { id, action } = await params;
  if (action === 'skip') {
    const body = await readJsonBody(request);
    const result = await skipRun(gate.deps, gate.actor, id, typeof body.runId === 'string' && body.runId ? { runId: body.runId } : {});
    return result.ok ? NextResponse.json({ run: result.run }, { headers: NO_STORE }) : asResponse(result);
  }
  if (action === 'stop' || action === 'resume') {
    const result = action === 'stop' ? await stopSchedule(gate.deps, gate.actor, id) : await resumeSchedule(gate.deps, gate.actor, id);
    return result.ok ? NextResponse.json({ schedule: result.schedule }, { headers: NO_STORE }) : asResponse(result);
  }
  return NextResponse.json({ error: 'No such action.', code: 'unknown_action' }, { status: 404, headers: NO_STORE });
}
