'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  BadgeCheck,
  Building2,
  Clock3,
  Globe2,
  Loader2,
  Mail,
  Phone,
  Save,
  ShieldCheck,
  Undo2,
  UserRound,
  XCircle,
} from 'lucide-react';

import DashPageHeader from '@/components/dashboard/DashPageHeader';

// Mirrors lib/server/customer-profile.ts (client copy of the wire types).
type AccountTier = 'TIER_1' | 'TIER_2' | 'TIER_3';

type Profile = {
  email: string;
  displayName: string;
  organization: string;
  phone: string;
  country: string;
  timezone: string;
  tier: AccountTier;
  updatedAt: string;
};

type ChangeFields = Partial<Pick<Profile, 'displayName' | 'organization' | 'phone' | 'country' | 'timezone' | 'tier'>>;

type ChangeRequest = {
  id: string;
  state: 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED';
  changes: ChangeFields;
  before: ChangeFields;
  note: string | null;
  submittedAt: string;
  decidedAt: string | null;
  decisionReason: string | null;
};

const TIERS: Array<{ id: AccountTier; name: string; blurb: string }> = [
  { id: 'TIER_3', name: 'Tier 3 · Starter', blurb: 'Default onboarding tier. Standard corridor limits with every payout reviewed.' },
  { id: 'TIER_2', name: 'Tier 2 · Growth', blurb: 'Raised daily limits and batch payouts once your payment history is established.' },
  { id: 'TIER_1', name: 'Tier 1 · Prime', blurb: 'Highest limits, treasury tools, and priority review. Granted after compliance sign-off.' },
];

const FIELD_LABELS: Record<string, string> = {
  displayName: 'Display name',
  organization: 'Organization',
  phone: 'Phone',
  country: 'Country',
  timezone: 'Timezone',
  tier: 'Account tier',
};

const COUNTRIES: Array<[string, string]> = [
  ['MY', 'Malaysia'], ['PH', 'Philippines'], ['ID', 'Indonesia'], ['SG', 'Singapore'],
  ['VN', 'Vietnam'], ['TH', 'Thailand'], ['HK', 'Hong Kong'], ['AU', 'Australia'],
];

const tierName = (tier: AccountTier | string | undefined) =>
  TIERS.find((t) => t.id === tier)?.name ?? String(tier ?? '');

const fieldValue = (field: string, value: unknown) =>
  field === 'tier' ? tierName(value as AccountTier) : String(value || '—');

export default function ProfilePage() {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [pending, setPending] = useState<ChangeRequest | null>(null);
  const [history, setHistory] = useState<ChangeRequest[]>([]);
  const [draft, setDraft] = useState<ChangeFields>({});
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  const load = useCallback(async () => {
    const response = await fetch('/api/profile', { cache: 'no-store' });
    if (!response.ok) return;
    const body = await response.json() as { profile: Profile; pendingRequest: ChangeRequest | null; history: ChangeRequest[] };
    setProfile(body.profile);
    setPending(body.pendingRequest);
    setHistory(body.history.filter((r) => r.state !== 'PENDING'));
  }, []);

  useEffect(() => {
    const timeout = setTimeout(() => void load(), 0);
    return () => clearTimeout(timeout);
  }, [load]);

  const merged = useMemo(() => profile ? { ...profile, ...draft } : null, [profile, draft]);
  const dirtyFields = useMemo(() => {
    if (!profile) return [];
    return (Object.keys(draft) as Array<keyof ChangeFields>).filter((k) => draft[k] !== undefined && draft[k] !== profile[k]);
  }, [draft, profile]);

  function edit<K extends keyof ChangeFields>(field: K, value: ChangeFields[K]) {
    setMessage(null);
    setDraft((current) => ({ ...current, [field]: value }));
  }

  async function submitForReview() {
    if (!profile || dirtyFields.length === 0) return;
    setBusy(true);
    setMessage(null);
    try {
      const payload: Record<string, unknown> = { note };
      for (const field of dirtyFields) payload[field] = draft[field];
      const response = await fetch('/api/profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? 'Unable to submit the change request.');
      setDraft({});
      setNote('');
      setMessage({ kind: 'ok', text: 'Saved for review. Our admin team will approve or decline it shortly.' });
      await load();
    } catch (error) {
      setMessage({ kind: 'error', text: error instanceof Error ? error.message : 'Unable to submit the change request.' });
    } finally {
      setBusy(false);
    }
  }

  async function cancelPending() {
    setBusy(true);
    try {
      const response = await fetch('/api/profile', { method: 'DELETE' });
      if (!response.ok) throw new Error((await response.json()).error ?? 'Unable to cancel.');
      setMessage({ kind: 'ok', text: 'Change request withdrawn.' });
      await load();
    } catch (error) {
      setMessage({ kind: 'error', text: error instanceof Error ? error.message : 'Unable to cancel.' });
    } finally {
      setBusy(false);
    }
  }

  if (!profile || !merged) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center text-[#326273]/60">
        <Loader2 className="mr-2 h-5 w-5 animate-spin" /> Loading profile…
      </div>
    );
  }

  const locked = Boolean(pending);

  return (
    <div className="mx-auto w-full max-w-6xl space-y-4">
      <DashPageHeader
        kicker="Your account"
        title="Profile"
        description="Review your details anytime. Edits are saved for admin review first — nothing changes until our side approves it."
      />

      {message && (
        <div className={`rounded-xl border px-4 py-3 text-sm font-medium ${
          message.kind === 'ok'
            ? 'border-[#5C9EAD]/30 bg-[#5C9EAD]/10 text-[#326273]'
            : 'border-[#E39774]/30 bg-[#E39774]/10 text-[#9b4e32]'
        }`}>
          {message.text}
        </div>
      )}

      {/* ── Pending review ticket ────────────────────────────── */}
      {pending && (
        <section className="overflow-hidden rounded-2xl border border-[#E39774]/40 bg-white shadow-[6px_7px_0_rgba(12,62,72,0.08)]">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-dashed border-[#326273]/20 bg-[#E39774]/10 px-5 py-3">
            <div className="flex items-center gap-2 text-sm font-bold text-[#9b4e32]">
              <Clock3 className="h-4 w-4" />
              Waiting for admin approval
            </div>
            <div className="text-[13px] font-medium text-[#326273]/55">
              Submitted {new Date(pending.submittedAt).toLocaleString()}
            </div>
          </div>
          <div className="grid gap-2 p-5">
            {Object.entries(pending.changes).map(([field, next]) => (
              <div key={field} className="grid items-center gap-2 rounded-xl bg-[#F6F0ED] px-4 py-3 text-sm sm:grid-cols-[140px_1fr_auto_1fr]">
                <span className="text-xs font-semibold uppercase tracking-[0.1em] text-[#326273]/55">{FIELD_LABELS[field] ?? field}</span>
                <span className="font-medium text-[#326273]/60 line-through decoration-[#E39774]/60">
                  {fieldValue(field, (pending.before as Record<string, unknown>)[field])}
                </span>
                <span aria-hidden="true" className="hidden text-[var(--info)] sm:block">→</span>
                <span className="font-bold text-[#326273]">{fieldValue(field, next)}</span>
              </div>
            ))}
            {pending.note && (
              <p className="px-1 pt-1 text-[13px] text-[#326273]/60">Note to reviewer: “{pending.note}”</p>
            )}
            <div className="pt-2">
              <button
                type="button"
                onClick={cancelPending}
                disabled={busy}
                className="inline-flex items-center gap-2 rounded-lg border border-[#326273]/15 bg-white px-4 py-2 text-[13px] font-semibold text-[#326273] transition-colors hover:bg-[#F6F0ED] disabled:opacity-50"
              >
                <Undo2 className="h-3.5 w-3.5" />
                Withdraw request
              </button>
            </div>
          </div>
        </section>
      )}

      <section className="grid gap-4 lg:grid-cols-[340px_minmax(0,1fr)]">
        {/* ── Profile of record ─────────────────────────────── */}
        <div className="dash-surface h-fit p-6">
          <div className="flex items-center gap-4">
            <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-[#1F4452] text-lg font-bold text-white">
              {profile.displayName.split(/\s+/).slice(0, 2).map((p) => p[0]?.toUpperCase()).join('') || 'S'}
            </div>
            <div className="min-w-0">
              <div className="truncate text-lg font-bold text-[#326273]">{profile.displayName}</div>
              <div className="truncate text-[13px] font-medium text-[#326273]/55">{profile.organization}</div>
            </div>
          </div>

          <div className="mt-5 inline-flex items-center gap-2 rounded-lg bg-[#5C9EAD]/12 px-3 py-2 text-[13px] font-bold text-[#326273]">
            <ShieldCheck className="h-4 w-4 text-[var(--info)]" />
            {tierName(profile.tier)}
          </div>

          <dl className="mt-5 space-y-3 text-sm">
            <RecordRow icon={Mail} label="Email (sign-in)" value={profile.email} />
            <RecordRow icon={Phone} label="Phone" value={profile.phone || 'Not set'} />
            <RecordRow icon={Globe2} label="Country" value={COUNTRIES.find(([c]) => c === profile.country)?.[1] ?? profile.country} />
            <RecordRow icon={Building2} label="Timezone" value={profile.timezone || 'Not set'} />
          </dl>

          <p className="mt-5 border-t border-[#326273]/10 pt-4 text-[13px] leading-5 text-[#326273]/50">
            <BadgeCheck className="mr-1 inline h-3.5 w-3.5 text-[var(--info)]" />
            This is your profile of record — the version our admin team has approved.
            {profile.updatedAt && new Date(profile.updatedAt).getTime() > 0
              ? ` Last approved change ${new Date(profile.updatedAt).toLocaleDateString()}.`
              : ' No approved changes yet.'}
          </p>
        </div>

        {/* ── Edit form (maker side) ────────────────────────── */}
        <form
          className="dash-surface p-6"
          onSubmit={(event) => { event.preventDefault(); void submitForReview(); }}
        >
          <div className="flex items-center gap-3">
            <UserRound className="text-[var(--info)]" />
            <div>
              <h2 className="text-xl font-bold text-[#326273]">Edit details</h2>
              <p className="text-[13px] text-[#326273]/55">
                {locked
                  ? 'Editing is paused while your current request is in review.'
                  : 'Change what you need, then save it for review.'}
              </p>
            </div>
          </div>

          <fieldset disabled={locked || busy} className="mt-5 grid gap-4 disabled:opacity-60 sm:grid-cols-2">
            <TextField label="Display name" value={merged.displayName} onChange={(v) => edit('displayName', v)} />
            <TextField label="Organization" value={merged.organization} onChange={(v) => edit('organization', v)} />
            <TextField label="Phone" value={merged.phone} placeholder="+60 12 345 6789" onChange={(v) => edit('phone', v)} />
            <label className="block">
              <span className="text-xs font-semibold uppercase tracking-[0.1em] text-[#326273]/55">Country</span>
              <select
                value={merged.country}
                onChange={(event) => edit('country', event.target.value)}
                className="mt-1 w-full rounded-lg border border-[#326273]/15 bg-[#F6F0ED] px-3 py-2.5 text-sm font-medium text-[#326273] focus:border-[#5C9EAD] focus:outline-none"
              >
                {COUNTRIES.map(([code, name]) => <option key={code} value={code}>{name}</option>)}
              </select>
            </label>
            <TextField label="Timezone" value={merged.timezone} placeholder="Asia/Kuala_Lumpur" onChange={(v) => edit('timezone', v)} className="sm:col-span-2" />
          </fieldset>

          {/* Tier request */}
          <div className="mt-6">
            <div className="text-xs font-semibold uppercase tracking-[0.1em] text-[#326273]/55">Account tier</div>
            <p className="mt-1 text-[13px] text-[#326273]/50">Request a different tier — upgrades apply only after compliance approves.</p>
            <div className="mt-3 grid gap-2 lg:grid-cols-3">
              {TIERS.map((tier) => {
                const selected = merged.tier === tier.id;
                const current = profile.tier === tier.id;
                return (
                  <button
                    key={tier.id}
                    type="button"
                    disabled={locked || busy}
                    onClick={() => edit('tier', tier.id)}
                    className={`rounded-xl border p-4 text-left transition-all disabled:opacity-60 ${
                      selected
                        ? 'border-[#5C9EAD] bg-[#5C9EAD]/8 shadow-[inset_0_0_0_1px_#5C9EAD]'
                        : 'border-[#326273]/12 bg-white hover:border-[#5C9EAD]/50'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm font-bold text-[#326273]">{tier.name}</span>
                      {current && <span className="rounded-full bg-[#326273]/10 px-2 py-0.5 text-[13px] font-bold text-[#326273]/60">Current</span>}
                    </div>
                    <p className="mt-1.5 text-[13px] leading-4 text-[#326273]/60">{tier.blurb}</p>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Note + submit */}
          <div className="mt-6 space-y-3">
            <label className="block">
              <span className="text-xs font-semibold uppercase tracking-[0.1em] text-[#326273]/55">Note to reviewer (optional)</span>
              <textarea
                value={note}
                disabled={locked || busy}
                onChange={(event) => setNote(event.target.value)}
                rows={2}
                placeholder="Anything that helps us review faster — e.g. why you need Tier 1."
                className="mt-1 w-full resize-none rounded-lg border border-[#326273]/15 bg-[#F6F0ED] px-3 py-2.5 text-sm text-[#326273] focus:border-[#5C9EAD] focus:outline-none disabled:opacity-60"
              />
            </label>

            <div className="flex flex-wrap items-center gap-3">
              <button
                type="submit"
                disabled={locked || busy || dirtyFields.length === 0}
                className="inline-flex items-center gap-2 rounded-lg bg-[#326273] px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-[#264e5b] disabled:cursor-not-allowed disabled:opacity-50"
              >
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                Save for review
              </button>
              {dirtyFields.length > 0 && !locked && (
                <>
                  <button
                    type="button"
                    onClick={() => { setDraft({}); setMessage(null); }}
                    className="text-[13px] font-semibold text-[#326273]/55 underline-offset-2 hover:underline"
                  >
                    Discard changes
                  </button>
                  <span className="text-[13px] font-medium text-[#326273]/45">
                    {dirtyFields.length} field{dirtyFields.length > 1 ? 's' : ''} will be sent for approval
                  </span>
                </>
              )}
            </div>
          </div>
        </form>
      </section>

      {/* ── Past requests ───────────────────────────────────── */}
      {history.length > 0 && (
        <section className="dash-surface p-6">
          <h2 className="text-sm font-semibold uppercase tracking-[0.1em] text-[#326273]/55">Review history</h2>
          <div className="mt-3 space-y-2">
            {history.map((request) => (
              <div key={request.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-xl bg-[#F6F0ED] px-4 py-3 text-[13px]">
                <StateBadge state={request.state} />
                <span className="font-medium text-[#326273]">
                  {Object.keys(request.changes).map((f) => FIELD_LABELS[f] ?? f).join(', ')}
                </span>
                <span className="text-[#326273]/45">
                  {new Date(request.submittedAt).toLocaleDateString()}
                  {request.decidedAt ? ` → decided ${new Date(request.decidedAt).toLocaleDateString()}` : ''}
                </span>
                {request.decisionReason && (
                  <span className="basis-full text-[#326273]/55">Reviewer: “{request.decisionReason}”</span>
                )}
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function RecordRow({ icon: Icon, label, value }: { icon: typeof Mail; label: string; value: string }) {
  return (
    <div className="flex items-start gap-3">
      <Icon className="mt-0.5 h-4 w-4 shrink-0 text-[var(--info)]" />
      <div className="min-w-0">
        <dt className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[#326273]/45">{label}</dt>
        <dd className="truncate text-sm font-medium text-[#326273]">{value}</dd>
      </div>
    </div>
  );
}

function TextField({ label, value, onChange, placeholder, className = '' }: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
}) {
  return (
    <label className={`block ${className}`}>
      <span className="text-xs font-semibold uppercase tracking-[0.1em] text-[#326273]/55">{label}</span>
      <input
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
        className="mt-1 w-full rounded-lg border border-[#326273]/15 bg-[#F6F0ED] px-3 py-2.5 text-sm font-medium text-[#326273] placeholder-[#326273]/30 focus:border-[#5C9EAD] focus:outline-none"
      />
    </label>
  );
}

function StateBadge({ state }: { state: ChangeRequest['state'] }) {
  const styles: Record<ChangeRequest['state'], string> = {
    PENDING: 'bg-[#E39774]/15 text-[#9b4e32]',
    APPROVED: 'bg-[#5C9EAD]/15 text-[#0d6370]',
    REJECTED: 'bg-red-100 text-red-700',
    CANCELLED: 'bg-[#326273]/10 text-[#326273]/60',
  };
  const icons: Record<ChangeRequest['state'], typeof BadgeCheck> = {
    PENDING: Clock3,
    APPROVED: BadgeCheck,
    REJECTED: XCircle,
    CANCELLED: Undo2,
  };
  const Icon = icons[state];
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 font-bold ${styles[state]}`}>
      <Icon className="h-3 w-3" />
      {state.charAt(0) + state.slice(1).toLowerCase()}
    </span>
  );
}
