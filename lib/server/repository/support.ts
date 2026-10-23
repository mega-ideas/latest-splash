/**
 * Postgres access for support tickets and their replies.
 *
 * Same shape as the other repositories: this module knows the tables, the
 * store above it (`lib/server/support.ts`) knows the rules, and a ticket comes
 * back in the shape the in-memory store always handed out, replies included.
 *
 * ─── Scoping ────────────────────────────────────────────────────────────────
 *
 * Every function takes `orgId: string | null`. A string scopes the query to
 * that org — a foreign id matches nothing and reads as missing, the same
 * answer an id that never existed gets. `null` is the staff console's reach
 * across tenants, and only the `*ForStaff` functions in the store pass it.
 * The scope is in the WHERE clause of the write, not checked beforehand, so
 * there is no window between "is it theirs?" and "change it".
 *
 * ─── Replies are inserts ────────────────────────────────────────────────────
 *
 * A reply is a row in `support_ticket_replies`. The `Map` rewrote the whole
 * replies array on every write; done in a database that is a read-modify-write
 * that loses one of two replies sent at the same moment.
 */
import { and, asc, desc, eq, inArray, type SQL } from 'drizzle-orm';
import type { PgDatabase } from 'drizzle-orm/pg-core';

import { supportTicketReplies, supportTickets } from '../../db/schema.ts';
import type * as schemaModule from '../../db/schema.ts';
import type { SupportReply, SupportTicketRecord } from '../support.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DrizzleDb = PgDatabase<any, typeof schemaModule, any>;

type TicketSelect = typeof supportTickets.$inferSelect;
type ReplySelect = typeof supportTicketReplies.$inferSelect;

function toReply(row: ReplySelect): SupportReply {
  return {
    id: row.id,
    actor: row.actor,
    actorType: row.actorType as SupportReply['actorType'],
    message: row.message,
    createdAt: row.createdAt.toISOString(),
  };
}

function toTicket(row: TicketSelect, replies: SupportReply[]): SupportTicketRecord {
  return {
    id: row.id,
    orgId: row.orgId,
    type: row.type as SupportTicketRecord['type'],
    subject: row.subject,
    message: row.message,
    email: row.email,
    status: row.status as SupportTicketRecord['status'],
    priority: row.priority as SupportTicketRecord['priority'],
    assignedTo: row.assignedTo,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    replies,
  };
}

function scoped(ticketId: string, orgId: string | null): SQL | undefined {
  return orgId === null
    ? eq(supportTickets.id, ticketId)
    : and(eq(supportTickets.id, ticketId), eq(supportTickets.orgId, orgId));
}

/** Attach each ticket's replies, oldest first, in one query. */
async function withReplies(db: DrizzleDb, rows: TicketSelect[]): Promise<SupportTicketRecord[]> {
  if (rows.length === 0) return [];
  const replyRows = await db
    .select()
    .from(supportTicketReplies)
    .where(inArray(supportTicketReplies.ticketId, rows.map((row) => row.id)))
    .orderBy(asc(supportTicketReplies.seq));
  const byTicket = new Map<string, SupportReply[]>();
  for (const reply of replyRows) {
    const list = byTicket.get(reply.ticketId) ?? [];
    list.push(toReply(reply));
    byTicket.set(reply.ticketId, list);
  }
  return rows.map((row) => toTicket(row, byTicket.get(row.id) ?? []));
}

export async function insertTicket(db: DrizzleDb, record: SupportTicketRecord): Promise<SupportTicketRecord> {
  const [row] = await db
    .insert(supportTickets)
    .values({
      id: record.id,
      orgId: record.orgId,
      type: record.type,
      subject: record.subject,
      message: record.message,
      email: record.email,
      status: record.status,
      priority: record.priority,
      assignedTo: record.assignedTo,
      createdAt: new Date(record.createdAt),
      updatedAt: new Date(record.updatedAt),
    })
    .returning();
  return toTicket(row, []);
}

/** Tickets, most recently touched first: one org's, or (`null`) every org's. */
export async function listTickets(db: DrizzleDb, orgId: string | null, limit = 500): Promise<SupportTicketRecord[]> {
  const query = db.select().from(supportTickets);
  const rows = await (orgId === null ? query : query.where(eq(supportTickets.orgId, orgId)))
    .orderBy(desc(supportTickets.updatedAt))
    .limit(limit);
  return withReplies(db, rows);
}

export async function readTicket(db: DrizzleDb, orgId: string | null, ticketId: string): Promise<SupportTicketRecord | null> {
  const rows = await db.select().from(supportTickets).where(scoped(ticketId, orgId)).limit(1);
  return rows.length > 0 ? (await withReplies(db, rows))[0] : null;
}

export type TicketChange = {
  status?: SupportTicketRecord['status'];
  /** `undefined` leaves the assignee alone; `null` clears it. */
  assignedTo?: string | null;
  reply?: SupportReply;
};

/**
 * Change a ticket and add a reply, in one transaction, with the ticket row
 * locked. `null` when the ticket is not there or (with an org) not theirs —
 * and then nothing was written.
 */
export async function changeTicket(
  db: DrizzleDb,
  orgId: string | null,
  ticketId: string,
  change: TicketChange,
): Promise<SupportTicketRecord | null> {
  const found = await db.transaction(async (tx) => {
    const locked = await tx.select().from(supportTickets).where(scoped(ticketId, orgId)).limit(1).for('update');
    if (locked.length === 0) return false;
    const ticket = locked[0];
    await tx
      .update(supportTickets)
      .set({
        status: change.status ?? (change.reply ? 'REPLIED' : ticket.status),
        assignedTo: change.assignedTo === undefined ? ticket.assignedTo : change.assignedTo,
        updatedAt: new Date(),
      })
      .where(eq(supportTickets.id, ticket.id));
    if (change.reply) {
      await tx.insert(supportTicketReplies).values({
        id: change.reply.id,
        ticketId: ticket.id,
        // The ticket's org, read from the locked row: a reply cannot be filed
        // under any other.
        orgId: ticket.orgId,
        actor: change.reply.actor,
        actorType: change.reply.actorType,
        message: change.reply.message,
        createdAt: new Date(change.reply.createdAt),
      });
    }
    return true;
  });
  return found ? readTicket(db, orgId, ticketId) : null;
}
