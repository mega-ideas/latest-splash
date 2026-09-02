import { createHash } from 'node:crypto';
import { and, asc, eq, gte } from 'drizzle-orm';

import { productEvents } from '../db/schema.ts';

/**
 * D8 — retention instrumentation.
 *
 * One narrow writer for the `product_events` table (activation funnel, NVR
 * cohorts, five-lock adoption, corridor mix, 0xWal reliability). Rules:
 *
 * - Server-side only. A browser bundle importing this is a build mistake;
 *   client surfaces report through POST /api/events, which is allow-listed to
 *   `CLIENT_EVENT_NAMES` and stamps orgId/actorId from the session.
 * - No raw ids, no PII. orgId / actorId / subjectId are sha256-hashed before
 *   they leave this module; prop keys that look like PII are dropped.
 * - Never throws to the caller. Analytics must not be able to fail a money
 *   route — every failure is a `console.warn('[events] …')` and a return.
 * - Works without a database. With `DATABASE_URL` unset (local demo, tests)
 *   events land in a globalThis ring buffer (cap 5,000) so `/admin/retention`
 *   still renders. The buffer is anchored on globalThis like every store in
 *   this repo: route handlers and server components get separate module
 *   instances in dev.
 *
 * Imports are deliberately relative (`../db/...`) and node built-ins only so
 * tests/product-events.test.mjs can load this file under
 * `node --experimental-strip-types` without the `@/` alias.
 */

export const EVENT_NAMES = [
  // lifecycle
  'account_created', 'kyb_submitted', 'kyb_approved', 'first_funding_received',
  // payments
  'intent_created', 'intent_settled', 'intent_paid_out', 'intent_confirmed', 'intent_returned',
  // batch
  'batch_uploaded', 'batch_validated', 'batch_settled', 'batch_scheduled', 'recurring_run',
  // approvals
  'policy_created', 'policy_updated', 'approval_requested', 'approval_granted', 'approval_rejected',
  // exports
  'export_downloaded', 'integration_connected',
  // counterparties
  'recipient_added', 'recipient_verified', 'recipient_reused',
  // yield
  'sweep_recommended', 'sweep_approved', 'sweep_executed', 'yield_position_opened',
  // 0xWal
  'session_started', 'message', 'action_proposed', 'action_approved', 'stream_reconnect',
  // proof / support
  'receipt_viewed', 'proof_drawer_opened', 'explorer_link_clicked', 'support_ticket_opened',
] as const;

export type EventName = (typeof EVENT_NAMES)[number];

/** The ONLY names a browser may report through POST /api/events. Everything
 *  money-related is emitted server-side where the transition happens. */
export const CLIENT_EVENT_NAMES = [
  'receipt_viewed',
  'proof_drawer_opened',
  'explorer_link_clicked',
  'export_downloaded',
  'stream_reconnect',
  'message',
] as const satisfies readonly EventName[];

export type ClientEventName = (typeof CLIENT_EVENT_NAMES)[number];

export type EventPropValue = string | number | boolean | null;

export interface EmitEventInput {
  name: EventName;
  orgId: string;
  actorId?: string | null;
  subjectId?: string | null;
  corridor?: string;
  amountMinor?: bigint | number | null;
  currency?: string;
  props?: Record<string, EventPropValue>;
  /** Defaults to now. Exposed for backfills and tests. */
  occurredAt?: Date;
}

/** A stored event — identical shape whether it came from Postgres or the
 *  in-memory ring buffer. Hashes only; never raw ids. */
export interface ProductEvent {
  id: string;
  name: EventName;
  orgHash: string;
  actorHash: string | null;
  subjectHash: string | null;
  corridor: string | null;
  amountMinor: bigint | null;
  currency: string | null;
  props: Record<string, EventPropValue>;
  occurredAt: Date;
}

export const RING_BUFFER_CAP = 5_000;

/** Prop keys matching this are PII by construction and are never stored. */
const PII_KEY = /email|name|account|iban|address|phone/i;
const MAX_PROP_KEYS = 24;
const MAX_PROP_STRING = 160;

type EventsGlobal = typeof globalThis & { splashProductEvents?: ProductEvent[] };
const globalStore = globalThis as EventsGlobal;

function ringBuffer(): ProductEvent[] {
  if (!globalStore.splashProductEvents) globalStore.splashProductEvents = [];
  return globalStore.splashProductEvents;
}

export function hashId(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function hashOptional(value: string | null | undefined): string | null {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed ? hashId(trimmed) : null;
}

/** Drop PII-looking keys, non-scalar values, and oversize strings. */
export function sanitizeProps(props: Record<string, unknown> | undefined): Record<string, EventPropValue> {
  const out: Record<string, EventPropValue> = {};
  if (!props || typeof props !== 'object') return out;
  let kept = 0;
  for (const [key, value] of Object.entries(props)) {
    if (kept >= MAX_PROP_KEYS) break;
    if (PII_KEY.test(key)) continue;
    if (value === null || typeof value === 'boolean') {
      out[key] = value;
    } else if (typeof value === 'number') {
      if (!Number.isFinite(value)) continue;
      out[key] = value;
    } else if (typeof value === 'string') {
      out[key] = value.length > MAX_PROP_STRING ? value.slice(0, MAX_PROP_STRING) : value;
    } else if (typeof value === 'bigint') {
      out[key] = value.toString();
    } else {
      continue;
    }
    kept += 1;
  }
  return out;
}

function toMinor(value: bigint | number | null | undefined): bigint | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'bigint') return value;
  if (!Number.isFinite(value)) return null;
  return BigInt(Math.trunc(value));
}

function hasDatabase(): boolean {
  return Boolean(process.env.DATABASE_URL);
}

function fallbackId(): string {
  // Ring-buffer rows never reach Postgres, so a random uuid-shaped id is fine.
  return globalThis.crypto?.randomUUID?.() ?? `evt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/** Build the storable row. Exported for tests; the hashing happens here so
 *  no code path can write a raw id. */
export function toProductEvent(input: EmitEventInput): ProductEvent {
  const orgId = typeof input.orgId === 'string' ? input.orgId.trim() : '';
  if (!orgId) throw new Error('orgId is required');
  return {
    id: fallbackId(),
    name: input.name,
    orgHash: hashId(orgId),
    actorHash: hashOptional(input.actorId),
    subjectHash: hashOptional(input.subjectId),
    corridor: input.corridor?.trim() || null,
    amountMinor: toMinor(input.amountMinor),
    currency: input.currency?.trim() || null,
    props: sanitizeProps(input.props),
    occurredAt: input.occurredAt ?? new Date(),
  };
}

/**
 * Record one product event. Fire-and-forget: `void emitEvent({...})`.
 * Resolves after the write (or the warn) — never rejects.
 */
export async function emitEvent(input: EmitEventInput): Promise<void> {
  if (typeof window !== 'undefined') {
    throw new Error('[events] emitEvent is server-side only — client surfaces report through POST /api/events');
  }
  try {
    if (!(EVENT_NAMES as readonly string[]).includes(input.name)) {
      console.warn(`[events] unknown event name "${String(input.name)}" — dropped`);
      return;
    }
    const event = toProductEvent(input);

    if (!hasDatabase()) {
      const buffer = ringBuffer();
      buffer.push(event);
      if (buffer.length > RING_BUFFER_CAP) buffer.splice(0, buffer.length - RING_BUFFER_CAP);
      return;
    }

    const { getDb } = await import('../db/client.ts');
    await getDb().insert(productEvents).values({
      name: event.name,
      orgHash: event.orgHash,
      actorHash: event.actorHash,
      subjectHash: event.subjectHash,
      corridor: event.corridor,
      amountMinor: event.amountMinor,
      currency: event.currency,
      props: event.props,
      occurredAt: event.occurredAt,
    });
  } catch (error) {
    console.warn(`[events] failed to record ${String(input?.name)}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export interface ListEventsInput {
  since: Date;
  name?: EventName;
}

/** Read events (ascending by occurred_at) from Postgres or the ring buffer.
 *  Like emitEvent, a read failure degrades to an empty list with a warn. */
export async function listEvents(input: ListEventsInput): Promise<ProductEvent[]> {
  try {
    if (!hasDatabase()) {
      return ringBuffer()
        .filter((event) => event.occurredAt >= input.since && (!input.name || event.name === input.name))
        .sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
    }

    const { getDb } = await import('../db/client.ts');
    const where = input.name
      ? and(gte(productEvents.occurredAt, input.since), eq(productEvents.name, input.name))
      : gte(productEvents.occurredAt, input.since);
    const rows = await getDb()
      .select()
      .from(productEvents)
      .where(where)
      .orderBy(asc(productEvents.occurredAt));
    return rows.map((row) => ({
      id: row.id,
      name: row.name as EventName,
      orgHash: row.orgHash,
      actorHash: row.actorHash,
      subjectHash: row.subjectHash,
      corridor: row.corridor,
      amountMinor: row.amountMinor,
      currency: row.currency,
      props: (row.props ?? {}) as Record<string, EventPropValue>,
      occurredAt: row.occurredAt,
    }));
  } catch (error) {
    console.warn(`[events] failed to list events: ${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
}

/** Test/dev helper: empty the in-memory buffer. No-op against Postgres. */
export function clearEventBuffer(): void {
  ringBuffer().length = 0;
}
