import { NextResponse } from 'next/server';
import { z } from 'zod';

import { requireCustomerRequest } from '@/lib/server/customer-auth';
import { readJsonBody } from '@/lib/server/http';
import { CLIENT_EVENT_NAMES, emitEvent } from '@/lib/server/events';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * D8 — the only door for UI-originated product events.
 *
 * The client sends a name from `CLIENT_EVENT_NAMES` plus optional
 * subject/corridor/props; org and actor come from the session, never the
 * body (same provenance stance as every money route). Money-related events
 * are emitted server-side where the transition happens, so they are not on
 * the allow-list here.
 */
const propValue = z.union([z.string().max(160), z.number().finite(), z.boolean(), z.null()]);

const clientEventSchema = z.object({
  name: z.enum(CLIENT_EVENT_NAMES),
  subjectId: z.string().trim().min(1).max(200).optional(),
  corridor: z.string().trim().regex(/^[A-Z]{3}_[A-Z]{3}$/).optional(),
  props: z.record(z.string().max(64), propValue).optional(),
});

export async function POST(request: Request) {
  const auth = await requireCustomerRequest(request);
  if (auth.response) return auth.response;

  const parsed = clientEventSchema.safeParse(await readJsonBody(request));
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid product event', code: 'invalid_event' }, { status: 400 });
  }

  const { session } = auth;
  void emitEvent({
    name: parsed.data.name,
    orgId: session.orgId ?? session.email,
    actorId: session.email,
    subjectId: parsed.data.subjectId ?? null,
    corridor: parsed.data.corridor,
    props: parsed.data.props,
  });

  return NextResponse.json({ ok: true }, { status: 202, headers: { 'Cache-Control': 'no-store' } });
}
