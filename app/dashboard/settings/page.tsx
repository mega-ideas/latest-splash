'use client';

import { useEffect, useState } from 'react';
import {
  BadgeCheck,
  Building2,
  Database,
  Landmark,
  Loader2,
  LockKeyhole,
  Save,
  ShieldCheck,
  SlidersHorizontal,
  Users,
  WalletCards,
} from 'lucide-react';

type Settings = {
  perTransferLimitUsd: number;
  dailyLimitUsd: number;
  approvalThresholdUsd: number;
  autoAllocateTreasuryPct: number;
  requireTotp: boolean;
  requireDualApproval: boolean;
  blockHighRiskCorridors: boolean;
  notifyOnSettlement: boolean;
  updatedAt: string;
};

const INFORMATION = [
  {
    icon: WalletCards,
    label: 'Custody',
    text: 'licensed partners are the system of record for customer funds · reconciled daily',
  },
  {
    icon: Landmark,
    label: 'Regulatory path',
    text: 'Labuan FSA Money Broker + DFS application in progress; Labuan → SG holdco → MAS; regulator-ready, not yet licensed',
  },
  {
    icon: Building2,
    label: 'Treasury',
    text: 'Smart Treasury models projected Ondo USDY yield; execution gated; projected, not promised',
  },
  {
    icon: Database,
    label: 'Records & privacy',
    text: 'Seal + Walrus + daily Merkle batches + MemWal behavioral-only',
  },
  {
    icon: Users,
    label: 'Recipient ladder',
    text: 'payout/sweep/stored',
  },
] as const;

export default function DashboardSettingsPage() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState('');

  useEffect(() => {
    void fetch('/api/settings')
      .then((response) => response.json())
      .then((body: Settings) => setSettings(body));
  }, []);

  function update<K extends keyof Settings>(key: K, value: Settings[K]) {
    setSettings((current) => current ? { ...current, [key]: value } : current);
  }

  async function save() {
    if (!settings) return;
    setSaving(true);
    setNotice('');
    const response = await fetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(settings),
    });
    const body = await response.json() as Settings & { error?: string };
    if (response.ok) {
      setSettings(body);
      setNotice('Operating controls saved.');
    } else {
      setNotice(body.error ?? 'Unable to save operating controls.');
    }
    setSaving(false);
  }

  if (!settings) {
    return <div className="flex min-h-[50vh] items-center justify-center"><Loader2 className="animate-spin text-[var(--info)]" /></div>;
  }

  return (
    <div className="mx-auto w-full max-w-6xl space-y-5">
      <header className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
        <div>
          <span className="dash-kicker">Operating policy</span>
          <h1 className="dash-title mt-2">Settings</h1>
          <p className="mt-1 max-w-2xl text-[13px] text-[#326273]/60">
            Persisted controls applied to payment approvals, treasury allocation, and account security.
          </p>
        </div>
        <button type="button" onClick={() => void save()} disabled={saving} className="inline-flex items-center justify-center gap-2 rounded-xl bg-[#073d49] px-5 py-3 text-sm font-bold text-white shadow-[0_5px_0_#022b33] transition-transform hover:-translate-y-0.5 disabled:opacity-50">
          {saving ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />}
          Save controls
        </button>
      </header>

      {notice && <div className="rounded-xl border border-[#5C9EAD]/25 bg-[#5C9EAD]/10 px-4 py-3 text-sm font-semibold text-[#326273]">{notice}</div>}

      <section className="grid gap-5 lg:grid-cols-[1.15fr_0.85fr]">
        <div className="dash-surface p-6">
          <div className="flex items-center gap-3">
            <SlidersHorizontal className="text-[var(--info)]" />
            <div>
              <h2 className="text-xl font-bold text-[#326273]">Payment controls</h2>
              <p className="text-[13px] text-[#326273]/55">Limits are enforced as an operating policy and preserved between sessions.</p>
            </div>
          </div>
          <div className="mt-6 grid gap-4 sm:grid-cols-2">
            <NumberControl label="Per-transfer limit" value={settings.perTransferLimitUsd} suffix="USD" onChange={(value) => update('perTransferLimitUsd', value)} />
            <NumberControl label="Daily limit" value={settings.dailyLimitUsd} suffix="USD" onChange={(value) => update('dailyLimitUsd', value)} />
            <NumberControl label="Approval threshold" value={settings.approvalThresholdUsd} suffix="USD" onChange={(value) => update('approvalThresholdUsd', value)} />
            <NumberControl label="Auto-allocate to treasury" value={settings.autoAllocateTreasuryPct} suffix="%" onChange={(value) => update('autoAllocateTreasuryPct', value)} />
          </div>
        </div>

        <div className="dash-surface p-6">
          <div className="flex items-center gap-3">
            <LockKeyhole className="text-[var(--info)]" />
            <div>
              <h2 className="text-xl font-bold text-[#326273]">Security controls</h2>
              <p className="text-[13px] text-[#326273]/55">Click a control to change the policy, then save.</p>
            </div>
          </div>
          <div className="mt-5 space-y-3">
            <Toggle label="TOTP authorization" active={settings.requireTotp} onClick={() => update('requireTotp', !settings.requireTotp)} />
            <Toggle label="Dual approval above threshold" active={settings.requireDualApproval} onClick={() => update('requireDualApproval', !settings.requireDualApproval)} />
            <Toggle label="Block high-risk corridors" active={settings.blockHighRiskCorridors} onClick={() => update('blockHighRiskCorridors', !settings.blockHighRiskCorridors)} />
            <Toggle label="Settlement notifications" active={settings.notifyOnSettlement} onClick={() => update('notifyOnSettlement', !settings.notifyOnSettlement)} />
          </div>
        </div>
      </section>

      <section className="dash-surface p-6">
        <div className="flex items-center gap-3">
          <ShieldCheck className="text-[var(--info)]" />
          <div>
            <h2 className="text-xl font-bold text-[#326273]">How Splash operates</h2>
            <p className="text-[13px] text-[#326273]/55">Plain-language operating position, without over-claiming.</p>
          </div>
        </div>
        <div className="mt-5 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {INFORMATION.map(({ icon: Icon, label, text }) => (
            <div key={label} className="rounded-2xl border border-[#326273]/10 bg-[#F6F0ED] p-5">
              <Icon size={20} className="text-[var(--info)]" />
              <div className="mt-3 text-xs font-semibold uppercase tracking-[0.12em] text-[#326273]/55">{label}</div>
              <p className="mt-2 text-sm font-medium leading-6 text-[#326273]">{text}</p>
            </div>
          ))}
        </div>
      </section>

      <div className="flex items-center gap-2 text-[13px] font-medium text-[#326273]/50">
        <BadgeCheck size={15} className="text-[var(--info)]" />
        Last persisted {new Date(settings.updatedAt).getTime() === 0 ? 'using policy defaults' : new Date(settings.updatedAt).toLocaleString()}
      </div>
    </div>
  );
}

function NumberControl({ label, value, suffix, onChange }: { label: string; value: number; suffix: string; onChange: (value: number) => void }) {
  return (
    <label className="rounded-2xl border border-[#326273]/10 bg-[#F6F0ED] p-4">
      <span className="text-xs font-semibold uppercase tracking-[0.1em] text-[#326273]/55">{label}</span>
      <span className="mt-3 flex items-center gap-2">
        <input type="number" min={0} value={value} onChange={(event) => onChange(Number(event.target.value))} className="min-w-0 flex-1 bg-transparent text-2xl font-bold text-[#326273] outline-none" />
        <span className="text-[13px] font-bold text-[var(--info)]">{suffix}</span>
      </span>
    </label>
  );
}

function Toggle({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="flex w-full items-center justify-between rounded-xl border border-[#326273]/10 bg-[#F6F0ED] p-4 text-left">
      <span className="text-sm font-semibold text-[#326273]">{label}</span>
      <span className={`h-6 w-11 rounded-full p-1 transition-colors ${active ? 'bg-[#5C9EAD]' : 'bg-[#326273]/20'}`}>
        <span className={`block h-4 w-4 rounded-full bg-white transition-transform ${active ? 'translate-x-5' : ''}`} />
      </span>
    </button>
  );
}
