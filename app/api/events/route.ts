import { NextResponse } from 'next/server';
import { z } from 'zod';

import { requireCustomerRequest } from '@/lib/server/customer-auth';
import { readJsonBody } from '@/lib/server/http';
import { CLIENT_EVENT_NAMES, emitEvent, hashId, listEvents, type EventName } from '@/lib/server/events';

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

const MAX_DAYS = 90;
const MAX_ROWS = 500;

/**
 * Audit log read: the caller's own organisation's events, newest first.
 * Identifiers are already hashed at write time; nothing here can be edited.
 * `?days=` (default 30, max 90) and `?name=` narrow the window.
 */
export async function GET(request: Request) {
  const auth = await requireCustomerRequest(request);
  if (auth.response) return auth.response;

  const url = new URL(request.url);
  const days = Math.min(MAX_DAYS, Math.max(1, Number.parseInt(url.searchParams.get('days') ?? '30', 10) || 30));
  const name = url.searchParams.get('name') as EventName | null;
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const orgHash = hashId(auth.session.orgId ?? auth.session.email);

  const events = await listEvents({ since, name: name ?? undefined });
  const items = events
    .filter((event) => event.orgHash === orgHash)
    .sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime())
    .slice(0, MAX_ROWS)
    .map((event) => ({
      id: event.id,
      name: event.name,
      actorHash: event.actorHash,
      subjectHash: event.subjectHash,
      corridor: event.corridor,
      amountMinor: event.amountMinor,
      currency: event.currency,
      props: event.props,
      occurredAt: event.occurredAt.toISOString(),
    }));

  return NextResponse.json({ items, since: since.toISOString(), days }, { headers: { 'Cache-Control': 'no-store' } });
}
