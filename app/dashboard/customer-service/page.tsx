'use client';

import { useState } from 'react';
import { Headphones, Send, Bug, MessageSquareWarning, MessageSquare, Mail, Phone, Clock3, BookOpen } from 'lucide-react';
import { toast } from 'sonner';

type SupportTicket = {
  id: string;
  type: string;
  subject: string;
  message: string;
  email: string | null;
  status: string;
  priority: string;
  createdAt: string;
  updatedAt: string;
  replies: {
    id: string;
    actor: string;
    actorType: 'customer' | 'staff';
    message: string;
    createdAt: string;
  }[];
};

const issueTypes = [
  { id: 'bug', label: 'Bug Report', icon: Bug, desc: 'Something is not working correctly' },
  { id: 'feature', label: 'Feature Request', icon: MessageSquare, desc: 'Suggest a new feature' },
  { id: 'complaint', label: 'Complaint', icon: MessageSquareWarning, desc: 'Report a problem or concern' },
  { id: 'other', label: 'Other', icon: Headphones, desc: 'General inquiry' },
];

const faqs = [
  { question: 'How long until my transfer settles?', answer: 'Most corridors clear within 3–5 minutes. The SLA target is under 10 minutes.' },
  { question: 'How do I authorize a batch payout?', answer: 'Upload a CSV in Batch Payout, review preflight, then confirm with your TOTP.' },
  { question: 'Where are receipts stored?', answer: 'Receipts are sealed on Sui and downloadable as PDF for your records.' },
];

const channels = [
  { icon: Mail, label: 'support@splash.finance', detail: 'Email · 24h response SLA' },
  { icon: Phone, label: '+60 3-1234 5678', detail: 'Mon–Fri · 9am–6pm MYT' },
  { icon: Clock3, label: 'Status: Operational', detail: 'All systems green' },
];

export default function CustomerServicePage() {
  const [type, setType] = useState('bug');
  const [subject, setSubject] = useState('');
  const [message, setMessage] = useState('');
  const [email, setEmail] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [ticket, setTicket] = useState<SupportTicket | null>(null);
  const [replyMessage, setReplyMessage] = useState('');
  const [sendingReply, setSendingReply] = useState(false);

  async function submit() {
    if (!subject || !message) {
      toast.error('Subject and message are required');
      return;
    }

    try {
      const response = await fetch('/api/support/tickets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type, subject, message, email }),
      });

      const body = await response.json() as { ticket?: SupportTicket; error?: string };

      if (!response.ok || !body.ticket) {
        throw new Error(body.error ?? 'Ticket submission failed');
      }

      setTicket(body.ticket);
      setSubmitted(true);
      toast.success(`Ticket ${body.ticket.id} submitted to staff support`);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Ticket submission failed';
      toast.error(errorMessage);
    }
  }

  async function refreshTicket() {
    if (!ticket) return;

    try {
      const response = await fetch(`/api/support/tickets/${ticket.id}`, { cache: 'no-store' });
      const body = await response.json() as { ticket?: SupportTicket; error?: string };

      if (!response.ok || !body.ticket) {
        throw new Error(body.error ?? 'Ticket refresh failed');
      }

      setTicket(body.ticket);
      toast.success('Ticket thread refreshed');
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Ticket refresh failed';
      toast.error(errorMessage);
    }
  }

  async function sendFollowUp() {
    if (!ticket || !replyMessage.trim()) {
      toast.error('Write a message before sending');
      return;
    }

    setSendingReply(true);

    try {
      const response = await fetch(`/api/support/tickets/${ticket.id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: replyMessage, email }),
      });
      const body = await response.json() as { ticket?: SupportTicket; error?: string };

      if (!response.ok || !body.ticket) {
        throw new Error(body.error ?? 'Follow-up message failed');
      }

      setTicket(body.ticket);
      setReplyMessage('');
      toast.success('Message sent to staff support');
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Follow-up message failed';
      toast.error(errorMessage);
    } finally {
      setSendingReply(false);
    }
  }

  function reset() {
    setType('bug');
    setSubject('');
    setMessage('');
    setEmail('');
    setSubmitted(false);
    setTicket(null);
    setReplyMessage('');
  }

  return (
    <div className="mx-auto w-full max-w-6xl space-y-5">
      <header className="flex flex-col gap-2 md:flex-row md:items-end md:justify-between">
        <div>
          <span className="dash-kicker">Operations support</span>
          <h1 className="dash-title mt-2">Customer Service</h1>
          <p className="mt-0.5 text-[13px] text-[#326273]/60">Submit issues, bugs, or complaints. We aim to respond within 24 hours.</p>
        </div>
        <div className="rounded-xl border border-[#326273]/10 bg-white px-3 py-2 text-[13px] font-medium text-[#326273]">
          Tickets · Avg first reply &lt; 6h
        </div>
      </header>

      <section className="grid gap-5 xl:grid-cols-[1.4fr_1fr]">
        <div>
          {submitted ? (
            <div className="space-y-4 rounded-2xl border border-[#5C9EAD]/20 bg-[#5C9EAD]/5 p-6">
              <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
                <div className="flex gap-4">
                  <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-[#5C9EAD]/10 text-[var(--info)]">
                    <Send className="h-7 w-7" />
                  </div>
                  <div>
                    <h2 className="text-lg font-semibold text-[#326273]">Ticket Submitted</h2>
                    <p className="mt-1 text-sm text-[#326273]/60">Your support request is now visible in the staff admin console.</p>
                    {ticket && <p className="mt-2 break-all font-mono text-[13px] text-[#326273]/60">Ticket ID: {ticket.id}</p>}
                  </div>
                </div>
                {ticket && <span className="rounded-full bg-white px-3 py-1 text-xs font-semibold uppercase tracking-wide text-[#326273]">{ticket.status}</span>}
              </div>

              {ticket && (
                <div className="dash-surface p-4 text-left">
                  <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
                    <div>
                      <div className="text-xs font-semibold uppercase tracking-wide text-[var(--info)]">{ticket.type} · {ticket.priority}</div>
                      <h3 className="mt-1 font-semibold text-[#326273]">{ticket.subject}</h3>
                    </div>
                    <button type="button" onClick={() => void refreshTicket()} className="rounded-lg border border-[#5C9EAD]/30 px-3 py-2 text-[13px] font-semibold text-[#326273] hover:border-[#5C9EAD]">
                      Refresh thread
                    </button>
                  </div>
                  <div className="mt-4 rounded-xl bg-[#F6F0ED] p-3 text-sm leading-6 text-[#326273]/70">{ticket.message}</div>

                  <div className="mt-4 space-y-3">
                    {ticket.replies.length === 0 && <div className="rounded-xl border border-dashed border-[#326273]/20 p-3 text-[13px] text-[#326273]/55">No staff reply yet. You can add more context below.</div>}
                    {ticket.replies.map((reply) => (
                      <div key={reply.id} className={`rounded-xl p-3 text-sm ${reply.actorType === 'staff' ? 'bg-[#5C9EAD]/10' : 'bg-[#F6F0ED]'}`}>
                        <div className="flex flex-col gap-1 md:flex-row md:items-center md:justify-between">
                          <span className="font-semibold text-[#326273]">{reply.actorType === 'staff' ? 'Splash staff' : 'You'} · {reply.actor}</span>
                          <span className="text-[13px] text-[#326273]/50">{new Date(reply.createdAt).toLocaleString()}</span>
                        </div>
                        <p className="mt-2 leading-6 text-[#326273]/70">{reply.message}</p>
                      </div>
                    ))}
                  </div>

                  <div className="mt-4">
                    <label className="text-[13px] font-medium text-[#326273]/70">Add a follow-up message</label>
                    <textarea value={replyMessage} onChange={(event) => setReplyMessage(event.target.value)} rows={3} className="mt-1 w-full resize-none rounded-lg border border-[#326273]/20 bg-[#F6F0ED] px-4 py-3 text-sm text-[#326273] focus:border-[#5C9EAD] focus:outline-none" placeholder="Add extra details for the support team..." />
                    <button type="button" disabled={sendingReply} onClick={() => void sendFollowUp()} className="mt-3 rounded-lg bg-[#5C9EAD] px-5 py-2.5 text-[13px] font-semibold text-white hover:bg-[#264e5b] disabled:opacity-60">
                      {sendingReply ? 'Sending…' : 'Send follow-up'}
                    </button>
                  </div>
                </div>
              )}

              <button onClick={reset} className="rounded-lg bg-[#326273] px-5 py-2.5 text-[13px] font-semibold text-white hover:bg-[#264e5b]">
                Submit another ticket
              </button>
            </div>
          ) : (
            <div className="dash-surface space-y-5 p-6">
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {issueTypes.map(({ id, label, icon: Icon, desc }) => (
                  <button
                    key={id}
                    type="button"
                    onClick={() => setType(id)}
                    className={`rounded-xl border p-3 text-left transition-all ${
                      type === id
                        ? 'border-[#5C9EAD] bg-[#5C9EAD]/10'
                        : 'border-[#326273]/10 bg-white hover:border-[#5C9EAD]/30'
                    }`}
                  >
                    <Icon className={`h-5 w-5 ${type === id ? 'text-[var(--info)]' : 'text-[#326273]/50'}`} />
                    <div className={`mt-1.5 text-[13px] font-semibold ${type === id ? 'text-[#326273]' : 'text-[#326273]/70'}`}>{label}</div>
                    <div className="mt-0.5 text-[13px] text-[#326273]/50 leading-tight">{desc}</div>
                  </button>
                ))}
              </div>

              <div>
                <label className="text-[13px] font-medium text-[#326273]/70">Subject</label>
                <input
                  value={subject}
                  onChange={(e) => setSubject(e.target.value)}
                  placeholder="Brief summary of your issue"
                  className="mt-1 w-full rounded-lg border border-[#326273]/20 bg-[#F6F0ED] px-4 py-3 text-sm text-[#326273] focus:border-[#5C9EAD] focus:outline-none"
                />
              </div>

              <div>
                <label className="text-[13px] font-medium text-[#326273]/70">Email (optional)</label>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="your@email.com"
                  className="mt-1 w-full rounded-lg border border-[#326273]/20 bg-[#F6F0ED] px-4 py-3 text-sm text-[#326273] focus:border-[#5C9EAD] focus:outline-none"
                />
              </div>

              <div>
                <label className="text-[13px] font-medium text-[#326273]/70">Message</label>
                <textarea
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  placeholder="Describe your issue in detail..."
                  rows={6}
                  className="mt-1 w-full resize-none rounded-lg border border-[#326273]/20 bg-[#F6F0ED] px-4 py-3 text-sm text-[#326273] focus:border-[#5C9EAD] focus:outline-none"
                />
              </div>

              <button
                onClick={() => void submit()}
                className="w-full rounded-lg bg-[#5C9EAD] px-4 py-3 font-semibold text-white hover:bg-[#264e5b]"
              >
                Submit Ticket
              </button>
            </div>
          )}
        </div>

        <aside className="space-y-4">
          <div className="dash-block p-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="text-sm font-semibold text-[#326273]">Get in touch</h2>
                <p className="mt-0.5 text-[13px] text-[#326273]/60">Direct channels to reach Splash support.</p>
              </div>
              <Headphones className="text-[var(--info)]" size={16} />
            </div>
            <div className="mt-3 space-y-2">
              {channels.map(({ icon: Icon, label, detail }) => (
                <div key={label} className="flex items-start gap-3 rounded-lg bg-[#F6F0ED] p-3">
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[#5C9EAD]/10 text-[var(--info)]">
                    <Icon className="h-4 w-4" />
                  </div>
                  <div className="min-w-0">
                    <div className="truncate text-[13px] font-semibold text-[#326273]">{label}</div>
                    <div className="mt-0.5 text-[13px] text-[#326273]/60">{detail}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="dash-block p-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="text-sm font-semibold text-[#326273]">Common questions</h2>
                <p className="mt-0.5 text-[13px] text-[#326273]/60">Quick answers before you raise a ticket.</p>
              </div>
              <BookOpen className="text-[var(--info)]" size={16} />
            </div>
            <div className="mt-3 space-y-2">
              {faqs.map((item) => (
                <details key={item.question} className="group rounded-lg bg-[#F6F0ED] p-3 text-[13px] text-[#326273] open:bg-[#5C9EAD]/10">
                  <summary className="cursor-pointer list-none font-medium marker:hidden">
                    {item.question}
                  </summary>
                  <p className="mt-2 text-[13px] leading-5 text-[#326273]/70">{item.answer}</p>
                </details>
              ))}
            </div>
          </div>

          <div className="rounded-2xl border border-[#E39774]/30 bg-[#E39774]/10 p-4 text-[13px] text-[#326273]/75">
            <div className="font-semibold uppercase tracking-[0.16em] text-[#E39774]">Priority support</div>
            <p className="mt-2 leading-5">
              Tier 1 KYB-approved customers get priority response. Mention your Splash organization ID in the message for fastest routing.
            </p>
          </div>
        </aside>
      </section>
    </div>
  );
}
