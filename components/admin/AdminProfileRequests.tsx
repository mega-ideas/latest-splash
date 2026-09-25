'use client';

import { useCallback, useEffect, useState } from 'react';
import { BadgeCheck, Clock3, Loader2, RefreshCcw, ShieldQuestion, Undo2, UserRoundCheck, XCircle } from 'lucide-react';

type ChangeFields = Record<string, string>;

type AdminProfileRequest = {
  id: string;
  email: string;
  state: 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED';
  changes: ChangeFields;
  before: ChangeFields;
  note: string | null;
  submittedAt: string;
  decidedAt: string | null;
  decidedBy: string | null;
  decisionReason: string | null;
  currentProfile: { displayName: string; organization: string; tier: string };
};

const FIELD_LABELS: Record<string, string> = {
  displayName: 'Display name',
  organization: 'Organization',
  phone: 'Phone',
  country: 'Country',
  timezone: 'Timezone',
  tier: 'Account tier',
};

const TIER_LABELS: Record<string, string> = {
  TIER_1: 'Tier 1 · Prime',
  TIER_2: 'Tier 2 · Growth',
  TIER_3: 'Tier 3 · Starter',
};

const display = (field: string, value: string | undefined) =>
  field === 'tier' ? (TIER_LABELS[value ?? ''] ?? value ?? '—') : (value || '—');

export default function AdminProfileRequests({ initialRequests }: { initialRequests: AdminProfileRequest[] }) {
  const [requests, setRequests] = useState(initialRequests);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const response = await fetch('/api/admin/profile-requests', { cache: 'no-store' });
    if (response.ok) {
      const body = await response.json() as { requests: AdminProfileRequest[] };
      setRequests(body.requests);
    }
  }, []);

  useEffect(() => {
    const interval = window.setInterval(() => { void refresh(); }, 30_000);
    return () => window.clearInterval(interval);
  }, [refresh]);

  async function decide(id: string, action: 'approve' | 'reject') {
    setBusyId(id);
    setError(null);
    try {
      const response = await fetch(`/api/admin/profile-requests/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, reason: reasons[id] ?? '' }),
      });
      if (!response.ok) throw new Error((await response.json()).error ?? 'Decision failed.');
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Decision failed.');
    } finally {
      setBusyId(null);
    }
  }

  const pending = requests.filter((r) => r.state === 'PENDING');
  const decided = requests.filter((r) => r.state !== 'PENDING').slice(0, 12);

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-black tracking-tight text-[#1F4452]">Profile change requests</h1>
          <p className="mt-1 text-sm text-[#1F4452]/90">
            Customer edits apply only after your approval — tier moves included.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void refresh()}
          className="inline-flex items-center gap-2 rounded-lg border border-[#326273]/15 bg-white px-3 py-2 text-xs font-bold text-[#1F4452] hover:bg-[#F6F0ED]"
        >
          <RefreshCcw className="h-3.5 w-3.5" />
          Refresh
        </button>
      </header>

      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-semibold text-red-700">{error}</div>
      )}

      {pending.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-[#326273]/20 bg-white/70 px-6 py-10 text-center">
          <ShieldQuestion className="mx-auto h-8 w-8 text-[#237284]" />
          <p className="mt-3 text-sm font-bold text-[#1F4452]">No requests waiting for review</p>
          <p className="mt-1 text-xs text-[#1F4452]/90">New customer profile edits will appear here for approval.</p>
        </div>
      ) : (
        <div className="space-y-4">
          {pending.map((request) => (
            <article key={request.id} className="overflow-hidden rounded-2xl border border-[#326273]/15 bg-white shadow-sm">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#326273]/10 bg-[#F6F0ED] px-5 py-3">
                <div className="flex items-center gap-3">
                  <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-[#1F4452] text-xs font-black text-white">
                    {request.currentProfile.displayName.slice(0, 2).toUpperCase()}
                  </span>
                  <div>
                    <div className="text-sm font-black text-[#1F4452]">{request.currentProfile.organization}</div>
                    <div className="text-xs text-[#1F4452]/90">{request.email} · {TIER_LABELS[request.currentProfile.tier] ?? request.currentProfile.tier}</div>
                  </div>
                </div>
                <div className="flex items-center gap-2 text-xs font-bold text-[#9b4e32]">
                  <Clock3 className="h-3.5 w-3.5" />
                  {new Date(request.submittedAt).toLocaleString()}
                </div>
              </div>

              <div className="space-y-2 px-5 py-4">
                {Object.entries(request.changes).map(([field, next]) => (
                  <div key={field} className="grid items-center gap-2 rounded-lg bg-[#EEF4F5] px-3 py-2.5 text-sm sm:grid-cols-[130px_1fr_auto_1fr]">
                    <span className="text-[12px] font-black uppercase tracking-[0.12em] text-[#1F4452]/90">{FIELD_LABELS[field] ?? field}</span>
                    <span className="font-semibold text-[#1F4452]/90 line-through decoration-[#E39774]/70">{display(field, request.before[field])}</span>
                    <span aria-hidden="true" className="hidden text-[#237284] sm:block">→</span>
                    <span className="font-black text-[#1F4452]">{display(field, next)}</span>
                  </div>
                ))}
                {request.note && (
                  <p className="pt-1 text-xs text-[#1F4452]/90">Customer note: “{request.note}”</p>
                )}
              </div>

              <div className="flex flex-wrap items-center gap-2 border-t border-[#326273]/10 px-5 py-3">
                <input
                  value={reasons[request.id] ?? ''}
                  onChange={(event) => setReasons((c) => ({ ...c, [request.id]: event.target.value }))}
                  placeholder="Decision note (optional, shown to the customer)"
                  className="min-w-0 flex-1 rounded-lg border border-[#326273]/70 bg-white px-3 py-2 text-xs text-[#1F4452] focus:border-[#5C9EAD] focus:outline-none"
                />
                <button
                  type="button"
                  disabled={busyId === request.id}
                  onClick={() => void decide(request.id, 'approve')}
                  className="inline-flex items-center gap-2 rounded-lg bg-[#0d6370] px-4 py-2 text-xs font-black text-white transition-colors hover:bg-[#1F4452] disabled:opacity-50"
                >
                  {busyId === request.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <UserRoundCheck className="h-3.5 w-3.5" />}
                  Approve &amp; apply
                </button>
                <button
                  type="button"
                  disabled={busyId === request.id}
                  onClick={() => void decide(request.id, 'reject')}
                  className="inline-flex items-center gap-2 rounded-lg border border-[#E39774]/50 bg-[#E39774]/10 px-4 py-2 text-xs font-black text-[#9b4e32] transition-colors hover:bg-[#E39774]/20 disabled:opacity-50"
                >
                  <XCircle className="h-3.5 w-3.5" />
                  Reject
                </button>
              </div>
            </article>
          ))}
        </div>
      )}

      {decided.length > 0 && (
        <section>
          <h2 className="text-xs font-black uppercase tracking-[0.14em] text-[#1F4452]/90">Recently decided</h2>
          <div className="mt-2 space-y-1.5">
            {decided.map((request) => (
              <div key={request.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg bg-white/70 px-4 py-2.5 text-xs">
                <StateBadge state={request.state} />
                <span className="font-bold text-[#1F4452]">{request.email}</span>
                <span className="text-[#1F4452]/90">{Object.keys(request.changes).map((f) => FIELD_LABELS[f] ?? f).join(', ')}</span>
                <span className="ml-auto text-[#1F4452]/90">
                  {request.decidedBy ? `${request.decidedBy} · ` : ''}
                  {request.decidedAt ? new Date(request.decidedAt).toLocaleString() : ''}
                </span>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function StateBadge({ state }: { state: AdminProfileRequest['state'] }) {
  const map = {
    PENDING: ['bg-[#E39774]/15 text-[#9b4e32]', Clock3],
    APPROVED: ['bg-[#5C9EAD]/15 text-[#0d6370]', BadgeCheck],
    REJECTED: ['bg-red-100 text-red-700', XCircle],
    CANCELLED: ['bg-[#326273]/10 text-[#326273]/90', Undo2],
  } as const;
  const [cls, Icon] = map[state];
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-black ${cls}`}>
      <Icon className="h-3 w-3" />
      {state.charAt(0) + state.slice(1).toLowerCase()}
    </span>
  );
}
