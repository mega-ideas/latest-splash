/**
 * Requests for pilot access, from the landing calculator (v2 brief D16).
 *
 * Stored server-side: Postgres (`access_requests`, migration 0033) when the
 * deployment has a database, an in-process Map on a development machine
 * without one. One request per email and route: the unique index makes a
 * repeat a no-op, so asking twice, or a script asking a thousand times for
 * one address, adds one row.
 *
 * Scoped: the public route can only write, and only a pilot route
 * (lib/landing/access-request.ts). Nothing a customer or a stranger can call
 * reads the list; the staff console reads it through
 * `listAccessRequestsForStaff`, behind its own session.
 */
import { randomUUID } from 'node:crypto';

import type { AccessRequest } from '@/lib/landing/access-request';

export type AccessRequestRecord = AccessRequest & { id: string; createdAt: string };

type Store = { rows: Map<string, AccessRequestRecord> };
const globalStore = globalThis as typeof globalThis & { splashAccessRequests?: Store };
const memory: Store = globalStore.splashAccessRequests ?? { rows: new Map() };
globalStore.splashAccessRequests = memory;

const keyOf = (email: string, currency: string) => `${email.toLowerCase()}|${currency}`;

let announced = false;
function usingPostgres(): boolean {
  if (process.env.DATABASE_URL) return true;
  if (!announced) {
    announced = true;
    console.warn('[access-requests] DATABASE_URL is not set, so access requests live in this process. Local development only.');
  }
  return false;
}

async function db() {
  const { getDb } = await import('../db/client.ts');
  return getDb();
}

/** Record one request. `created` is false when this email already asked for this route. */
export async function recordAccessRequest(input: AccessRequest): Promise<{ created: boolean }> {
  const email = input.email.trim().toLowerCase();
  const record: AccessRequestRecord = {
    id: `access_${randomUUID()}`,
    email,
    company: input.company.trim(),
    currency: input.currency,
    createdAt: new Date().toISOString(),
  };
  if (usingPostgres()) {
    const { accessRequests } = await import('../db/schema.ts');
    const inserted = await (await db())
      .insert(accessRequests)
      .values({ id: record.id, email, company: record.company, currency: record.currency })
      .onConflictDoNothing({ target: [accessRequests.email, accessRequests.currency] })
      .returning({ id: accessRequests.id });
    return { created: inserted.length > 0 };
  }
  const key = keyOf(email, input.currency);
  if (memory.rows.has(key)) return { created: false };
  memory.rows.set(key, record);
  return { created: true };
}

/** Every request, newest first. The staff console only. */
export async function listAccessRequestsForStaff(): Promise<AccessRequestRecord[]> {
  if (usingPostgres()) {
    const { accessRequests } = await import('../db/schema.ts');
    const { desc } = await import('drizzle-orm');
    const rows = await (await db()).select().from(accessRequests).orderBy(desc(accessRequests.createdAt));
    return rows.map((row) => ({
      id: row.id,
      email: row.email,
      company: row.company,
      currency: row.currency as AccessRequest['currency'],
      createdAt: row.createdAt.toISOString(),
    }));
  }
  return [...memory.rows.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Tests only: forget the in-process requests. */
export function resetAccessRequestsForTests(): void {
  memory.rows.clear();
}
