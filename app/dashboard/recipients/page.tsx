'use client';

import { useEffect, useState } from 'react';
import { ArrowUpRight, Plus, Search, Trash2, Building2, Globe2, CreditCard, Layers, Send, ShieldCheck, Sparkles, Users } from 'lucide-react';
import { toast } from 'sonner';
import Link from 'next/link';

import DashPageHeader from '@/components/dashboard/DashPageHeader';
import QuickLinksCard from '@/components/dashboard/QuickLinksCard';
import StatusBadge from '@/components/StatusBadge';
import type { RecipientRecord } from '@/lib/server/operations';

const corridorBreakdown = [
  { country: 'PH', count: 2, percent: 40 },
  { country: 'SG', count: 1, percent: 20 },
  { country: 'ID', count: 1, percent: 20 },
  { country: 'MY', count: 1, percent: 20 },
];

export default function RecipientsPage() {
  const [recipients, setRecipients] = useState<RecipientRecord[]>([]);
  const [showAddForm, setShowAddForm] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [form, setForm] = useState({ name: '', country: 'PH', bank: '', swift: '', account: '' });

  useEffect(() => {
    let active = true;
    void fetch('/api/recipients')
      .then((response) => response.json())
      .then((records: RecipientRecord[]) => { if (active) setRecipients(records); });
    return () => { active = false; };
  }, []);

  const filtered = recipients.filter((r) =>
    String(r.name ?? '').toLowerCase().includes(searchQuery.toLowerCase()) ||
    String(r.bank ?? '').toLowerCase().includes(searchQuery.toLowerCase())
  );

  async function addRecipient() {
    if (!form.name || !form.account) {
      toast.error('Name and account number are required');
      return;
    }
    const response = await fetch('/api/recipients', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(form),
    });
    if (!response.ok) return toast.error('Recipient could not be added');
    const newRecipient = (await response.json()) as RecipientRecord;
    setRecipients((prev) => [...prev, newRecipient]);
    setForm({ name: '', country: 'PH', bank: '', swift: '', account: '' });
    setShowAddForm(false);
    toast.success('Recipient added successfully');
  }

  async function removeRecipient(id: string) {
    const response = await fetch(`/api/recipients/${id}`, { method: 'DELETE' });
    if (!response.ok) return toast.error('Recipient could not be removed');
    setRecipients((prev) => prev.filter((r) => r.id !== id));
    toast.success('Recipient removed');
  }

  return (
    <div className="mx-auto w-full max-w-6xl space-y-5">
      <DashPageHeader
        kicker="Global directory"
        title="Recipients"
        description="Manage beneficiaries and delivery depth. Payment status and history live in History."
        actions={
          <button onClick={() => setShowAddForm((v) => !v)} className="dash-btn !px-4 !py-2 !text-[13px]">
            <Plus className="h-4 w-4" />
            New recipient
          </button>
        }
      />

      {showAddForm && (
        <div className="rounded-xl border border-[#326273]/10 bg-white p-4">
          <h2 className="text-lg font-semibold text-[#326273]">Add new recipient</h2>
          <div className="mt-3 grid gap-3 md:grid-cols-2">
            <Field label="Recipient name">
              <input
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                placeholder="e.g. PT Maju Indonesia"
                className="w-full rounded-lg border border-[#326273]/20 bg-[#F6F0ED] px-3 py-2 text-sm text-[#326273] focus:border-[#5C9EAD] focus:outline-none"
              />
            </Field>
            <Field label="Country">
              <select
                value={form.country}
                onChange={(e) => setForm((f) => ({ ...f, country: e.target.value }))}
                className="w-full rounded-lg border border-[#326273]/20 bg-[#F6F0ED] px-3 py-2 text-sm text-[#326273] focus:border-[#5C9EAD] focus:outline-none"
              >
                <option value="MY">Malaysia</option>
                <option value="PH">Philippines</option>
                <option value="ID">Indonesia</option>
                <option value="SG">Singapore</option>
                <option value="TH">Thailand</option>
              </select>
            </Field>
            <Field label="Bank name">
              <input
                value={form.bank}
                onChange={(e) => setForm((f) => ({ ...f, bank: e.target.value }))}
                placeholder="e.g. BDO Unibank"
                className="w-full rounded-lg border border-[#326273]/20 bg-[#F6F0ED] px-3 py-2 text-sm text-[#326273] focus:border-[#5C9EAD] focus:outline-none"
              />
            </Field>
            <Field label="SWIFT/BIC (optional)">
              <input
                value={form.swift}
                onChange={(e) => setForm((f) => ({ ...f, swift: e.target.value }))}
                placeholder="e.g. BNORPHMM"
                className="w-full rounded-lg border border-[#326273]/20 bg-[#F6F0ED] px-3 py-2 text-sm text-[#326273] focus:border-[#5C9EAD] focus:outline-none"
              />
            </Field>
            <Field label="Account number" className="md:col-span-2">
              <input
                value={form.account}
                onChange={(e) => setForm((f) => ({ ...f, account: e.target.value }))}
                placeholder="e.g. 1234567890"
                className="w-full rounded-lg border border-[#326273]/20 bg-[#F6F0ED] px-3 py-2 text-sm font-mono text-[#326273] focus:border-[#5C9EAD] focus:outline-none"
              />
            </Field>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <button onClick={addRecipient} className="rounded-lg bg-[#5C9EAD] px-4 py-2 text-[13px] font-semibold text-white hover:bg-[#264e5b]">
              Save recipient
            </button>
            <button onClick={() => setShowAddForm(false)} className="rounded-lg border border-[#326273]/20 px-4 py-2 text-[13px] font-medium text-[#326273]">
              Cancel
            </button>
          </div>
        </div>
      )}

      <section className="grid gap-5 xl:grid-cols-[1.6fr_1fr]">
        <div className="space-y-4">
          <div className="dash-surface flex flex-wrap items-center gap-2 p-2">
            <span className="rounded-lg bg-[#326273] px-3 py-2 text-[13px] font-medium text-white sm:px-4">
              Recipients ({recipients.length})
            </span>
            <Link
              href="/dashboard/history"
              className="flex items-center gap-1 rounded-lg px-3 py-2 text-[13px] font-medium text-[#326273] transition-colors hover:bg-[#F6F0ED] sm:px-4"
            >
              Payment history <ArrowUpRight className="h-3 w-3" />
            </Link>
            <div className="ml-auto flex min-w-0 items-center gap-2">
              <Search className="h-4 w-4 shrink-0 text-[#326273]/50" />
              <input
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search recipients…"
                className="w-32 rounded-lg border border-[#326273]/20 bg-[#F6F0ED] px-3 py-1.5 text-[13px] text-[#326273] focus:border-[#5C9EAD] focus:outline-none sm:w-44"
              />
            </div>
          </div>

          <div className="space-y-3">
            {filtered.length === 0 ? (
              <div className="dash-surface p-6 text-center text-sm text-[#326273]/60">No recipients found.</div>
            ) : (
              filtered.map((r) => (
                <div key={r.id} className="dash-block dash-block-interactive flex items-center justify-between gap-3 p-3 sm:p-4">
                  <div className="flex min-w-0 items-center gap-3">
                    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[#5C9EAD]/10 text-[var(--info)]">
                      <Building2 className="h-5 w-5" />
                    </div>
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2"><span className="truncate text-sm font-semibold text-[#326273]">{r.name}</span>{r.demo && <StatusBadge status="demo" />}</div>
                      <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[13px] text-[#326273]/60">
                        <span className="flex items-center gap-1"><Globe2 className="h-3 w-3" /> {r.country}</span>
                        <span className="flex items-center gap-1"><CreditCard className="h-3 w-3" /> {r.bank || 'No bank account'}</span>
                        {r.account && <span className="font-mono">{r.account}</span>}
                        <span className="rounded-full bg-[#5C9EAD]/10 px-2 py-0.5 font-semibold text-[var(--info)]">{r.tier.replaceAll('_', ' ')}</span>
                      </div>
                    </div>
                  </div>
                  <button onClick={() => removeRecipient(r.id)} className="rounded-lg p-2 text-[#E39774] hover:bg-[#E39774]/10" aria-label="Remove recipient">
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              ))
            )}
          </div>
        </div>

        <aside className="space-y-4">
          <div className="dash-block p-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="text-sm font-semibold text-[#326273]">Corridor mix</h2>
                <p className="mt-0.5 text-[13px] text-[#326273]/60">Where your beneficiaries are.</p>
              </div>
              <Globe2 className="text-[var(--info)]" size={16} />
            </div>
            <div className="mt-4 space-y-3">
              {corridorBreakdown.map((corridor) => (
                <div key={corridor.country}>
                  <div className="flex items-center justify-between text-[13px] text-[#326273]/65">
                    <span className="font-mono font-semibold text-[#326273]">USD → {corridor.country}</span>
                    <span>{corridor.count} · {corridor.percent}%</span>
                  </div>
                  <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-[#F6F0ED]">
                    <div className="h-full rounded-full bg-[#5C9EAD]" style={{ width: `${corridor.percent}%` }} />
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="rounded-xl border border-[#5C9EAD]/20 bg-[#5C9EAD]/10 p-4">
            <div className="flex items-start gap-3">
              <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-[var(--info)]" />
              <div>
                <div className="text-sm font-semibold text-[#326273]">Compliance check</div>
                <p className="mt-1 text-[13px] leading-5 text-[#326273]/65">
                  Beneficiaries are screened automatically against AML, PEP, and sanctions lists before any value moves.
                </p>
                <Link href="/dashboard/settings" className="mt-3 inline-flex items-center gap-1 text-[13px] font-semibold text-[var(--info)] hover:underline">
                  View screening rules →
                </Link>
              </div>
            </div>
          </div>

          <div className="dash-block p-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="text-sm font-semibold text-[#326273]">Quick actions</h2>
                <p className="mt-0.5 text-[13px] text-[#326273]/60">Move money to these recipients.</p>
              </div>
              <Sparkles className="text-[#E39774]" size={16} />
            </div>
            <QuickLinksCard
              className="mt-3"
              links={[
                { label: 'Single transfer', href: '/dashboard/transfer', icon: Send },
                { label: 'Batch CSV payout', href: '/dashboard/batch', icon: Layers },
              ]}
            />
          </div>

          <div className="dash-block p-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="text-sm font-semibold text-[#326273]">Beneficiary stats</h2>
                <p className="mt-0.5 text-[13px] text-[#326273]/60">Snapshot of your address book.</p>
              </div>
              <Users className="text-[var(--info)]" size={16} />
            </div>
            <div className="mt-3 grid grid-cols-2 gap-2 text-[13px]">
              <div className="rounded-lg bg-[#F6F0ED] p-2.5">
                <div className="text-[10px] uppercase tracking-wide text-[#326273]/55">Total</div>
                <div className="mt-0.5 text-lg font-semibold text-[#326273]">{recipients.length}</div>
              </div>
              <div className="rounded-lg bg-[#F6F0ED] p-2.5">
                <div className="text-[10px] uppercase tracking-wide text-[#326273]/55">Active corridors</div>
                <div className="mt-0.5 text-lg font-semibold text-[#326273]">{corridorBreakdown.length}</div>
              </div>
            </div>
          </div>
        </aside>
      </section>
    </div>
  );
}

function Field({ label, children, className = '' }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={className}>
      <label className="text-[13px] font-medium text-[#326273]/70">{label}</label>
      <div className="mt-1">{children}</div>
    </div>
  );
}
