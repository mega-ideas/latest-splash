import { NextResponse } from 'next/server';

import { readJsonBody } from '@/lib/server/http';
import { requireTermsAccepted } from '@/lib/server/onboarding';
import { automaticStatus, createSchedule, listScheduleViews } from '@/lib/server/scheduled-payments';
import { scheduleRoute } from '@/lib/server/scheduled-payments-deps';
import { itemsFromBody } from '@/lib/server/scheduled-payments-route';
import { withFeeGuard } from '@/lib/server/wallet-batches-route';
import { asResponse, limitWalletReads, limitWalletRequests, NO_STORE, requirePayoutReader } from '@/lib/server/wallet-route';

export const dynamic = 'force-dynamic';

/**
 * Scheduled batches (v2 Phase 3): a batch of payments to recipients the
 * business saved, once, every week or every month, in a mode an owner chooses:
 * “Ask me first” (Splash prepares it and asks for approval) or “Pay
 * automatically within my limits” (inside an allowance the owners signed). The
 * business and the person are the session's.
 *
 * GET   this business's schedules with their latest runs; for an owner also
 *       the automatic-payments status (the scheduled payer, the allowance as
 *       the network has it, the kill switch, the daily limit).
 * POST  { name, mode, cadence, firstDueAt, items: [{ recipientId | businessId,
 *       amount, reference? }], confirmNewPayees? } with an Idempotency-Key
 *       header (or `clientKey`). An owner sets either mode; the Finance lead
 *       sets “ask me first”; nobody else sets one.
 */
export async function GET(request: Request) {
  const gate = await scheduleRoute(request);
  if (gate.response) return gate.response;
  const reader = requirePayoutReader(gate.route);
  if (reader) return reader;
  const limited = await limitWalletReads(gate.route.authority.userId);
  if (limited) return limited;
  const schedules = await listScheduleViews(gate.deps, gate.actor);
  const owner = gate.actor.role === 'OWNER';
  return NextResponse.json(
    {
      schedules,
      automatic: owner ? await automaticStatus(gate.deps) : null,
      you: { role: gate.actor.role, owner, financeLead: gate.actor.financeLead === true, canSchedule: owner || gate.actor.financeLead === true },
    },
    { headers: NO_STORE },
  );
}

export async function POST(request: Request) {
  const gate = await scheduleRoute(request);
  if (gate.response) return gate.response;
  const termsGate = await requireTermsAccepted(gate.route.orgId);
  if (termsGate) return termsGate;
  const limited = await limitWalletRequests(gate.route);
  if (limited) return limited;
  const body = await readJsonBody(request);
  return withFeeGuard(async () => {
    const result = await createSchedule(gate.deps, gate.actor, {
      clientKey: request.headers.get('idempotency-key') ?? body.clientKey,
      name: body.name,
      mode: body.mode,
      cadence: body.cadence,
      firstDueAt: body.firstDueAt,
      items: itemsFromBody(body.items),
      confirmNewPayees: body.confirmNewPayees === true,
    });
    if (!result.ok) return asResponse(result);
    return NextResponse.json({ schedule: result.schedule, created: result.created }, { status: result.created ? 201 : 200, headers: NO_STORE });
  });
}
