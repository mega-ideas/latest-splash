'use client';

import { useMemo, useState } from 'react';
import { Headphones, Loader2, Mail, MessageSquareReply, Send } from 'lucide-react';
import { toast } from 'sonner';

import type { SupportTicketRecord, SupportTicketStatus } from '@/lib/server/support';

type Props = {
  initialTickets: SupportTicketRecord[];
};

const statusLabels: Record<SupportTicketStatus, string> = {
  OPEN: 'Open',
  IN_REVIEW: 'In review',
  REPLIED: 'Replied',
  CLOSED: 'Closed',
};

function statusClass(status: SupportTicketStatus) {
  if (status === 'REPLIED' || status === 'CLOSED') return 'border-[#5C9EAD]/30 bg-[#5C9EAD]/10 text-[#326273]';
  if (status === 'IN_REVIEW') return 'border-[var(--warn)] bg-[var(--warn-bg)] text-[var(--warn)]';
  return 'border-red-500/20 bg-red-500/10 text-red-700';
}

export default function AdminSupportConsole({ initialTickets }: Props) {
  const [tickets, setTickets] = useState(initialTickets);
  const [selectedId, setSelectedId] = useState(initialTickets[0]?.id ?? '');
  const [replyMessage, setReplyMessage] = useState('');
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const selected = useMemo(() => tickets.find((ticket) => ticket.id === selectedId) ?? tickets[0] ?? null, [selectedId, tickets]);

  async function refreshTickets() {
    setRefreshing(true);

    try {
      const response = await fetch('/api/admin/support', { cache: 'no-store' });
      const body = await response.json() as { tickets?: SupportTicketRecord[]; error?: string };

      if (!response.ok || !body.tickets) {
        throw new Error(body.error ?? 'Support inbox refresh failed');
      }

      setTickets(body.tickets);
      setSelectedId((current) => body.tickets?.some((ticket) => ticket.id === current) ? current : body.tickets?.[0]?.id ?? '');
      toast.success('Support inbox refreshed');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Support inbox refresh failed';
      toast.error(message);
    } finally {
      setRefreshing(false);
    }
  }

  async function updateTicket(status?: SupportTicketStatus) {
    if (!selected) return;
    setLoading(true);

    try {
      const response = await fetch(`/api/admin/support/${selected.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status, replyMessage, assignedTo: 'support@splash.finance' }),
      });
      const body = await response.json() as { ticket?: SupportTicketRecord; error?: string };

      if (!response.ok || !body.ticket) {
        throw new Error(body.error ?? 'Ticket update failed');
      }

      const updatedTicket = body.ticket;
      setTickets((current) => current.map((ticket) => (ticket.id === updatedTicket.id ? updatedTicket : ticket)));
      setSelectedId(updatedTicket.id);
      setReplyMessage('');
      toast.success(status ? `Ticket marked ${String(statusLabels[status] ?? status).toLowerCase()}` : 'Reply saved');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Ticket update failed';
      toast.error(message);
    } finally {
      setLoading(false);
    }
  }

  const openCount = tickets.filter((ticket) => ticket.status === 'OPEN').length;
  const complaintCount = tickets.filter((ticket) => ticket.type === 'complaint').length;
  const repliedCount = tickets.filter((ticket) => ticket.status === 'REPLIED' || ticket.status === 'CLOSED').length;

  return (
    <div className="space-y-6">
      <header className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
        <div>
          <div className="mb-2 inline-flex rounded-full bg-[#E39774]/10 px-3 py-1 text-xs font-bold uppercase tracking-wide text-[#E39774]">Customer Operations</div>
          <h1 className="text-3xl font-black tracking-[-0.03em] text-[#1f4350]">Feedback and complaint management</h1>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-[#326273]/65">Staff can triage incoming bugs, feature requests, complaints, and general support tickets separately from the customer dashboard.</p>
        </div>
        <div className="grid grid-cols-3 gap-2 rounded-2xl border border-[#326273]/10 bg-white p-2 text-center shadow-sm">
          <Metric label="Open" value={openCount} />
          <Metric label="Complaints" value={complaintCount} />
          <Metric label="Handled" value={repliedCount} />
        </div>
      </header>

      <section className="grid gap-6 xl:grid-cols-[0.95fr_1.35fr]">
        <div className="rounded-2xl border border-[#326273]/10 bg-white p-4 shadow-sm">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="font-bold text-[#1f4350]">Ticket inbox</h2>
            <button type="button" disabled={refreshing} onClick={() => void refreshTickets()} className="inline-flex items-center gap-2 rounded-lg border border-[#5C9EAD]/30 px-3 py-2 text-xs font-bold text-[#326273] hover:border-[#5C9EAD] disabled:opacity-60">
              {refreshing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Headphones className="h-4 w-4 text-[#5C9EAD]" />}
              Refresh
            </button>
          </div>
          <div className="space-y-3">
            {tickets.map((ticket) => (
              <button key={ticket.id} type="button" onClick={() => setSelectedId(ticket.id)} className={`w-full rounded-2xl border p-4 text-left transition ${selected?.id === ticket.id ? 'border-[#5C9EAD] bg-[#5C9EAD]/10' : 'border-[#326273]/10 hover:border-[#5C9EAD]/40'}`}>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="truncate font-bold text-[#1f4350]">{ticket.subject}</div>
                    <div className="mt-1 text-[11px] font-bold uppercase tracking-wide text-[#326273]/45">{ticket.type} · {ticket.priority}</div>
                  </div>
                  <span className={`shrink-0 rounded-full border px-2.5 py-1 text-[11px] font-bold ${statusClass(ticket.status)}`}>{statusLabels[ticket.status]}</span>
                </div>
                <p className="mt-3 line-clamp-2 text-xs leading-5 text-[#326273]/60">{ticket.message}</p>
              </button>
            ))}
          </div>
        </div>

        {selected && (
          <div className="space-y-5">
            <section className="rounded-2xl border border-[#326273]/10 bg-white p-6 shadow-sm">
              <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
                <div>
                  <div className="text-xs font-bold uppercase tracking-[0.2em] text-[#5C9EAD]">{selected.id}</div>
                  <h2 className="mt-2 text-2xl font-black text-[#1f4350]">{selected.subject}</h2>
                  <p className="mt-1 text-sm text-[#326273]/60">{selected.email ?? 'No email supplied'} · {new Date(selected.createdAt).toLocaleString()}</p>
                </div>
                <span className={`rounded-full border px-3 py-1 text-xs font-bold ${statusClass(selected.status)}`}>{statusLabels[selected.status]}</span>
              </div>

              <div className="mt-6 rounded-2xl bg-[#F6F0ED] p-5 text-sm leading-6 text-[#326273]/75">{selected.message}</div>

              <div className="mt-5 grid gap-3 md:grid-cols-4">
                <Info label="Type" value={selected.type} />
                <Info label="Priority" value={selected.priority} />
                <Info label="Assigned" value={selected.assignedTo ?? 'Unassigned'} />
                <Info label="Replies" value={String(selected.replies.length)} />
              </div>
            </section>

            <section className="rounded-2xl border border-[#326273]/10 bg-white p-5 shadow-sm">
              <div className="mb-4 flex items-center gap-2 font-bold text-[#1f4350]"><MessageSquareReply className="h-5 w-5 text-[#5C9EAD]" /> Staff reply</div>
              <textarea value={replyMessage} onChange={(event) => setReplyMessage(event.target.value)} rows={6} placeholder="Write a customer reply or internal resolution note" className="w-full resize-none rounded-xl border border-[#326273]/15 bg-[#F6F0ED] px-4 py-3 text-sm outline-none focus:border-[#5C9EAD]" />
              <div className="mt-4 grid gap-2 sm:grid-cols-3">
                <button type="button" disabled={loading} onClick={() => void updateTicket('IN_REVIEW')} className="rounded-xl bg-[#326273] px-4 py-3 text-sm font-bold text-white transition hover:bg-[#254e5c] disabled:opacity-60">Mark in review</button>
                <button type="button" disabled={loading || !replyMessage.trim()} onClick={() => void updateTicket('REPLIED')} className="flex items-center justify-center gap-2 rounded-xl bg-[#5C9EAD] px-4 py-3 text-sm font-bold text-white transition hover:bg-[#4a8b99] disabled:opacity-60">
                  {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                  Send reply
                </button>
                <button type="button" disabled={loading} onClick={() => void updateTicket('CLOSED')} className="rounded-xl bg-[#E39774] px-4 py-3 text-sm font-bold text-white transition hover:bg-[#cd825f] disabled:opacity-60">Close ticket</button>
              </div>
            </section>

            <section className="rounded-2xl border border-[#326273]/10 bg-white p-5 shadow-sm">
              <div className="mb-4 flex items-center gap-2 font-bold text-[#1f4350]"><Mail className="h-5 w-5 text-[#5C9EAD]" /> Reply history</div>
              <div className="space-y-3">
                {selected.replies.length === 0 && <div className="rounded-xl bg-[#F6F0ED] p-4 text-sm text-[#326273]/60">No staff replies yet.</div>}
                {selected.replies.map((reply) => (
                  <div key={reply.id} className="rounded-xl bg-[#F6F0ED] p-4 text-sm">
                    <div className="flex flex-col gap-1 md:flex-row md:items-center md:justify-between">
                      <span className="font-bold text-[#1f4350]">{reply.actor}</span>
                      <span className="text-xs text-[#326273]/50">{new Date(reply.createdAt).toLocaleString()}</span>
                    </div>
                    <p className="mt-2 leading-6 text-[#326273]/70">{reply.message}</p>
                  </div>
                ))}
              </div>
            </section>
          </div>
        )}
      </section>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-xl bg-[#F6F0ED] px-5 py-3">
      <div className="text-2xl font-black text-[#1f4350]">{value}</div>
      <div className="text-[11px] font-bold uppercase tracking-wide text-[#326273]/55">{label}</div>
    </div>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl bg-[#F6F0ED] p-3">
      <div className="text-[11px] font-bold uppercase tracking-wide text-[#326273]/50">{label}</div>
      <div className="mt-1 truncate text-sm font-bold capitalize text-[#1f4350]">{value}</div>
    </div>
  );
}
