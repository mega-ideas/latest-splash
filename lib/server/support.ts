import { BRAND } from '@/content/brand';

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

export function listSupportTickets() {
  return Array.from(supportStore.tickets.values()).sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
}

export function readSupportTicket(ticketId: string) {
  return supportStore.tickets.get(ticketId) ?? null;
}

export function createSupportTicket(input: { type: SupportTicketType; subject: string; message: string; email?: string | null }) {
  const now = new Date().toISOString();
  const record: SupportTicketRecord = {
    id: id('ticket'),
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

export function updateSupportTicket(ticketId: string, input: { status?: SupportTicketStatus; actor: string; actorType?: SupportReply['actorType']; replyMessage?: string; assignedTo?: string | null }) {
  const record = supportStore.tickets.get(ticketId);

  if (!record) {
    return null;
  }

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
