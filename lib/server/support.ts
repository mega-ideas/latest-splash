/**
 * Support tickets, belonging to somebody.
 *
 * Same rule as the transfer, invoice, beneficiary and ledger stores: `orgId`
 * is the first, required argument of every customer read and write, and it
 * comes from the session (`requireSessionAccount`), never from the request.
 * `listSupportTickets()` and `readSupportTicket(id)` used to take no org, so
 * any signed-in customer could list every tenant's tickets — subjects,
 * messages, contact addresses, staff replies — or read one by id.
 *
 * The staff console reads across tenants, and says so: `*ForStaff`, behind
 * `getAdminSession()` only. A foreign id reads as missing, the same answer a
 * non-existent id gets, so probing tells a caller nothing.
 */
import { BRAND } from '@/content/brand';
import { DEMO_ORG_ID } from '@/lib/server/operations';

export type SupportTicketType = 'bug' | 'feature' | 'complaint' | 'other';
export type SupportTicketStatus = 'OPEN' | 'IN_REVIEW' | 'REPLIED' | 'CLOSED';

export type SupportReply = {
  id: string;
  actor: string;
  actorType: 'customer' | 'staff';
  message: string;
  createdAt: string;
};

export type SupportTicketRecord = {
  id: string;
  /** The workspace that raised it. Every customer read is scoped by it. */
  orgId: string;
  type: SupportTicketType;
  subject: string;
  message: string;
  email: string | null;
  status: SupportTicketStatus;
  priority: 'NORMAL' | 'HIGH';
  assignedTo: string | null;
  createdAt: string;
  updatedAt: string;
  replies: SupportReply[];
};

type SupportStore = {
  tickets: Map<string, SupportTicketRecord>;
};

const globalStore = globalThis as typeof globalThis & { splashSupportStore?: SupportStore };

function id(prefix: string) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function reply(actor: string, message: string, actorType: SupportReply['actorType']): SupportReply {
  return {
    id: id('reply'),
    actor,
    actorType,
    message,
    createdAt: new Date().toISOString(),
  };
}

function seededTickets() {
  const complaintId = 'ticket_demo_delayed_batch';
  const questionId = 'ticket_demo_receipt_question';
  const now = Date.now();

  return new Map<string, SupportTicketRecord>([
    [
      complaintId,
      {
        id: complaintId,
        orgId: DEMO_ORG_ID,
        type: 'complaint',
        subject: 'Batch payout still pending after SLA',
        message: 'Our Philippines supplier batch has not moved from queued for more than 20 minutes. Please check if there is a rail issue.',
        email: 'ops@acmetrading.my',
        status: 'OPEN',
        priority: 'HIGH',
        assignedTo: null,
        createdAt: new Date(now - 1000 * 60 * 36).toISOString(),
        updatedAt: new Date(now - 1000 * 60 * 36).toISOString(),
        replies: [],
      },
    ],
    [
      questionId,
      {
        id: questionId,
        orgId: DEMO_ORG_ID,
        type: 'other',
        subject: 'Need receipt object ID for audit file',
        message: 'Can support confirm where the on-chain receipt object ID is shown after settlement?',
        email: 'finance@nusantaraexports.my',
        status: 'REPLIED',
        priority: 'NORMAL',
        assignedTo: BRAND.supportEmail,
        createdAt: new Date(now - 1000 * 60 * 180).toISOString(),
        updatedAt: new Date(now - 1000 * 60 * 105).toISOString(),
        replies: [reply(BRAND.supportEmail, 'The receipt object ID appears on the completed transfer receipt and in the transfer status timeline.', 'staff')],
      },
    ],
  ]);
}

export const supportStore = globalStore.splashSupportStore ?? {
  tickets: seededTickets(),
};

globalStore.splashSupportStore = supportStore;

function newestFirst(a: SupportTicketRecord, b: SupportTicketRecord) {
  return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
}

/** An org's own tickets, newest first. An empty org owns nothing. */
export function listSupportTickets(orgId: string) {
  if (!orgId) return [];
  return Array.from(supportStore.tickets.values()).filter((ticket) => ticket.orgId === orgId).sort(newestFirst);
}

/** One ticket belonging to `orgId`. A foreign id reads as missing. */
export function readSupportTicket(orgId: string, ticketId: string) {
  const record = supportStore.tickets.get(ticketId) ?? null;
  return record && orgId && record.orgId === orgId ? record : null;
}

/** Every tenant's tickets. The staff console only, behind `getAdminSession()`. */
export function listSupportTicketsForStaff() {
  return Array.from(supportStore.tickets.values()).sort(newestFirst);
}

/** Any ticket by id. The staff console only, behind `getAdminSession()`. */
export function readSupportTicketForStaff(ticketId: string) {
  return supportStore.tickets.get(ticketId) ?? null;
}

export function createSupportTicket(orgId: string, input: { type: SupportTicketType; subject: string; message: string; email?: string | null }) {
  if (!orgId) throw new Error('A support ticket belongs to a workspace.');
  const now = new Date().toISOString();
  const record: SupportTicketRecord = {
    id: id('ticket'),
    orgId,
    type: input.type,
    subject: input.subject,
    message: input.message,
    email: input.email?.trim() || null,
    status: 'OPEN',
    priority: input.type === 'complaint' ? 'HIGH' : 'NORMAL',
    assignedTo: null,
    createdAt: now,
    updatedAt: now,
    replies: [],
  };

  supportStore.tickets.set(record.id, record);

  return record;
}

type SupportTicketUpdate = {
  status?: SupportTicketStatus;
  actor: string;
  actorType?: SupportReply['actorType'];
  replyMessage?: string;
  assignedTo?: string | null;
};

function applyUpdate(record: SupportTicketRecord, input: SupportTicketUpdate) {
  const replyMessage = input.replyMessage?.trim();
  record.status = input.status ?? (replyMessage ? 'REPLIED' : record.status);
  record.assignedTo = input.assignedTo === undefined ? record.assignedTo : input.assignedTo;
  record.updatedAt = new Date().toISOString();

  if (replyMessage) {
    record.replies = [...record.replies, reply(input.actor, replyMessage, input.actorType ?? 'staff')];
  }

  supportStore.tickets.set(record.id, record);

  return record;
}

/** A customer's reply, scoped. `null` means it was not there OR was not theirs. */
export function updateSupportTicket(orgId: string, ticketId: string, input: SupportTicketUpdate) {
  const record = readSupportTicket(orgId, ticketId);
  return record ? applyUpdate(record, input) : null;
}

/** A staff reply or status change, on any tenant's ticket. Staff console only. */
export function updateSupportTicketForStaff(ticketId: string, input: SupportTicketUpdate) {
  const record = readSupportTicketForStaff(ticketId);
  return record ? applyUpdate(record, input) : null;
}
