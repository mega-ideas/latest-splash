import { NextResponse } from 'next/server';

import { readJsonBody } from '@/lib/server/http';
import { requireTermsAccepted } from '@/lib/server/onboarding';
import { deleteSchedule, editSchedule, getScheduleView, type SchedulePatch } from '@/lib/server/scheduled-payments';
import { scheduleRoute } from '@/lib/server/scheduled-payments-deps';
import { itemsFromBody } from '@/lib/server/scheduled-payments-route';
import { withFeeGuard } from '@/lib/server/wallet-batches-route';
import { asResponse, limitWalletRequests, NO_STORE, requirePayoutReader } from '@/lib/server/wallet-route';

export const dynamic = 'force-dynamic';

/**
 * One schedule. Another business's reads as absent (404).
 *
 * GET     the schedule and its latest runs.
 * PATCH   change it, at once, with no cooldown: { name?, mode?, cadence?,
 *         firstDueAt?, items?, confirmNewPayees? }. Switching to “Ask me first”
 *         takes effect for the very next run. An owner changes any schedule;
 *         the Finance lead changes only “ask me first” ones.
 * DELETE  delete it, at once. Its history stays.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await scheduleRoute(request);
  if (gate.response) return gate.response;
  const reader = requirePayoutReader(gate.route);
  if (reader) return reader;
  const { id } = await params;
  const schedule = await getScheduleView(gate.deps, gate.actor, id);
  if (!schedule) return NextResponse.json({ error: 'No such schedule.', code: 'schedule_not_found' }, { status: 404, headers: NO_STORE });
  return NextResponse.json({ schedule }, { headers: NO_STORE });
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await scheduleRoute(request);
  if (gate.response) return gate.response;
  const termsGate = await requireTermsAccepted(gate.route.orgId);
  if (termsGate) return termsGate;
  const limited = await limitWalletRequests(gate.route);
  if (limited) return limited;
  const { id } = await params;
  const body = await readJsonBody(request);
  const patch: SchedulePatch = {};
  for (const key of ['name', 'mode', 'cadence', 'firstDueAt'] as const) if (body[key] !== undefined) patch[key] = body[key];
  if (body.items !== undefined) patch.items = itemsFromBody(body.items);
  if (body.confirmNewPayees === true) patch.confirmNewPayees = true;
  return withFeeGuard(async () => {
    const result = await editSchedule(gate.deps, gate.actor, id, patch);
    return result.ok ? NextResponse.json({ schedule: result.schedule }, { headers: NO_STORE }) : asResponse(result);
  });
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await scheduleRoute(request);
  if (gate.response) return gate.response;
  const { id } = await params;
  const result = await deleteSchedule(gate.deps, gate.actor, id);
  return result.ok ? NextResponse.json({ deleted: true }, { headers: NO_STORE }) : asResponse(result);
}
