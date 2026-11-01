'use client';

import { useEffect, useState } from 'react';
import { BadgeCheck, Loader2, LockKeyhole, Save, SlidersHorizontal } from 'lucide-react';

import ApprovalFlow from '@/components/approvals/ApprovalFlow';
import LocalTime from '@/components/LocalTime';
import { Card, Note } from '@/components/wallet/parts';
import { CONTROLS_SCOPE_NOTE } from '@/lib/settings-page/controls';

type Settings = {
  perTransferLimitUsd: number;
  dailyLimitUsd: number;
  approvalThresholdUsd: number;
  autoAllocateTreasuryPct: number;
  requireTotp: boolean;
  requireDualApproval: boolean;
  blockHighRiskCorridors: boolean;
  notifyOnSettlement: boolean;
  /** How an approver is asked to approve. Persisted server-side already; the page simply never carried it, so saving used to blank it back to default. */
  approvalChannel: 'code' | 'reply';
  whatsappEnabled: boolean;
  updatedAt: string;
};

// No allocation happens automatically: every Treasury swap is made from the
// business's own Splash Wallet by its owners (v2 D9).
const AUTO_ALLOCATE_NOTE = 'Not offered: every Treasury swap is made from your Splash Wallet by its owners, never automatically.';

/** The settings the business's operating policy persists, and what the owners' approvals channel is. The settings object is shared with the approvals card, which changes its own two fields. */
export function useOperatingSettings() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void fetch('/api/settings')
      .then(async (response) => {
        const body = (await response.json().catch(() => null)) as (Settings & { error?: string }) | null;
        if (!live) return;
        if (!response.ok || !body) setProblem(body?.error ?? 'Your operating controls could not be loaded.');
        else setSettings(body);
      })
      .catch(() => {
        if (live) setProblem('Could not reach Splash. Your operating controls were not loaded.');
      });
    return () => {
      live = false;
    };
  }, []);
  return { settings, setSettings, problem };
}

export type OperatingSettings = Settings;

/**
 * Operating controls: the limits and switches the business applies to payment
 * approvals and account security, persisted between sessions. When WhatsApp
 * approvals are on, saving needs a code and a passkey confirmation for exactly
 * the change shown; edit anything and it needs a new approval.
 */
export default function OperatingControls({ settings, setSettings, editable }: { settings: Settings; setSettings: (next: Settings | ((current: Settings | null) => Settings | null)) => void; /** Only an owner or a finance admin can move the limits; for anyone else the values are read-only and there is no Save. */ editable: boolean }) {
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState('');
  // The exact body awaiting approval: the approval covers these bytes, and the retry sends them unchanged.
  const [approvalFor, setApprovalFor] = useState<Settings | null>(null);

  function update<K extends keyof Settings>(key: K, value: Settings[K]) {
    setSettings((current) => (current ? { ...current, [key]: value } : current));
  }

  async function save(exact?: Settings) {
    const payload = exact ?? settings;
    setSaving(true);
    setNotice('');
    const response = await fetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const body = (await response.json().catch(() => ({}))) as Settings & { error?: string; code?: string };
    if (response.ok) {
      setSettings(body);
      setApprovalFor(null);
      setNotice('Operating controls saved.');
    } else if (body.code === 'approval_required') {
      // WhatsApp approvals are on: this exact change needs a code + passkey.
      setApprovalFor(payload);
    } else {
      setNotice(body.error ?? 'Unable to save operating controls.');
    }
    setSaving(false);
  }

  return (
    <Card
      id="controls"
      title="Operating controls"
      aside={
        !editable ? null : <button type="button" onClick={() => void save()} disabled={saving} className="inline-flex h-10 items-center justify-center gap-2 rounded-xl bg-[#073d49] px-4 text-[13px] font-bold text-white transition-colors hover:bg-[#0d6370] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0d6370] disabled:opacity-50">
          {saving ? <Loader2 size={16} className="animate-spin" aria-hidden="true" /> : <Save size={16} aria-hidden="true" />}
          Save controls
        </button>
      }
    >
      <div className="space-y-5">
        <p className="text-[13px] leading-5 text-[#326273]">Limits and switches applied to payment approvals and account security. They are kept between sessions. {editable ? '' : 'An owner or a finance admin changes them; you can read them here.'}</p>
        <p className="text-[13px] leading-5 text-[#326273]">{CONTROLS_SCOPE_NOTE}</p>
        {notice ? <p role="status" className="rounded-xl border border-[#5C9EAD]/25 bg-[#5C9EAD]/10 px-4 py-3 text-sm font-semibold text-[#1F4452]">{notice}</p> : null}

        {approvalFor ? (
          <section className="rounded-2xl border border-[#326273]/15 bg-white p-4" aria-labelledby="settings-approval-title">
            <h3 id="settings-approval-title" className="text-base font-extrabold text-[#0c3e48]">Approve this change</h3>
            <p className="mt-1 text-[13px] leading-5 text-[#326273]">
              WhatsApp approvals are on, so saving these controls needs a WhatsApp code and a passkey confirmation for exactly the change below. Edit anything and it needs a new approval.
            </p>
            <div className="mt-4">
              <ApprovalFlow purpose="SETTINGS_CHANGE" payload={approvalFor} onApproved={() => void save(approvalFor)} />
            </div>
            <button type="button" onClick={() => setApprovalFor(null)} className="dash-btn-ghost mt-4 !px-4 !py-2 !text-[13px]">Cancel</button>
          </section>
        ) : null}

        <div className="grid gap-5">
          <div>
            <h3 className="flex items-center gap-2 text-sm font-extrabold text-[#0c3e48]"><SlidersHorizontal className="h-4 w-4 text-[var(--info)]" aria-hidden="true" />Payment controls</h3>
            <p className="mt-1.5 max-w-[62ch] text-[13px] leading-5 text-[#326273]">
              These limits apply to payments your team sends. The limits for payments Splash makes for you automatically are separate: see <a href="#limits" className="font-semibold text-[#0d6370] underline underline-offset-2">Limits on automatic payments</a>.
            </p>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <NumberControl readOnly={!editable} label="Per-transfer limit" value={settings.perTransferLimitUsd} suffix="USD" onChange={(value) => update('perTransferLimitUsd', value)} />
              <NumberControl readOnly={!editable} label="Daily limit" value={settings.dailyLimitUsd} suffix="USD" onChange={(value) => update('dailyLimitUsd', value)} />
              <NumberControl readOnly={!editable} label="Approval threshold" value={settings.approvalThresholdUsd} suffix="USD" onChange={(value) => update('approvalThresholdUsd', value)} />
              <NumberControl readOnly={!editable} label="Auto-allocate to treasury" value={settings.autoAllocateTreasuryPct} suffix="%" onChange={(value) => update('autoAllocateTreasuryPct', value)} disabled note={AUTO_ALLOCATE_NOTE} />
            </div>
          </div>
          <div>
            <h3 className="flex items-center gap-2 text-sm font-extrabold text-[#0c3e48]"><LockKeyhole className="h-4 w-4 text-[var(--info)]" aria-hidden="true" />Security controls</h3>
            <div className="mt-3 grid gap-2.5 sm:grid-cols-2">
              <Toggle disabled={!editable} label="TOTP authorization" active={settings.requireTotp} onClick={() => update('requireTotp', !settings.requireTotp)} />
              <Toggle disabled={!editable} label="Dual approval above threshold" active={settings.requireDualApproval} onClick={() => update('requireDualApproval', !settings.requireDualApproval)} />
              <Toggle disabled={!editable} label="Block high-risk corridors" active={settings.blockHighRiskCorridors} onClick={() => update('blockHighRiskCorridors', !settings.blockHighRiskCorridors)} />
              <Toggle disabled={!editable} label="Settlement notifications" active={settings.notifyOnSettlement} onClick={() => update('notifyOnSettlement', !settings.notifyOnSettlement)} />
            </div>
          </div>
        </div>

        <p className="flex items-center gap-2 text-[13px] font-medium text-[#326273]">
          <BadgeCheck size={15} className="text-[var(--info)]" aria-hidden="true" />
          Last saved {new Date(settings.updatedAt).getTime() === 0 ? 'using the defaults' : <LocalTime value={settings.updatedAt} />}
        </p>
      </div>
    </Card>
  );
}

/** The settings could not load: a sentence and nothing to edit. */
export function OperatingControlsUnavailable({ problem }: { problem: string }) {
  return <Card id="controls" title="Operating controls"><Note tone="error">{problem}</Note></Card>;
}

function NumberControl({ label, value, suffix, onChange, disabled = false, readOnly = false, note }: { label: string; value: number; suffix: string; onChange: (value: number) => void; disabled?: boolean; readOnly?: boolean; note?: string }) {
  return (
    <label className={`block rounded-2xl border border-[#326273]/10 bg-[#F6F0ED] p-4 ${disabled ? 'cursor-not-allowed border-dashed' : ''}`}>
      <span className="text-[13px] font-semibold text-[#1F4452]">{label}</span>
      {/* Only the value dims; the reason below keeps full contrast. */}
      <span className="mt-2 flex items-center gap-2">
        <input type="number" min={0} value={value} disabled={disabled} readOnly={readOnly} onChange={(event) => onChange(Number(event.target.value))} className="w-full min-w-0 flex-1 bg-transparent text-xl font-bold tabular-nums text-[#326273] outline-none disabled:cursor-not-allowed disabled:opacity-50" />
        {/* The unit is a word, not the value: it keeps full contrast when the control is read-only. */}
        <span className="text-[13px] font-bold text-[#1F4452]">{suffix}</span>
      </span>
      {note && (
        <span className="mt-2 flex items-start gap-1.5 text-[12px] font-semibold leading-5 text-[#326273]">
          <LockKeyhole size={13} className="mt-0.5 shrink-0" aria-hidden="true" />
          {note}
        </span>
      )}
    </label>
  );
}

function Toggle({ label, active, onClick, disabled = false }: { label: string; active: boolean; onClick: () => void; disabled?: boolean }) {
  return (
    <button type="button" role="switch" aria-checked={active} aria-disabled={disabled} onClick={disabled ? undefined : onClick} className={`flex min-h-12 w-full items-center justify-between rounded-xl border border-[#326273]/10 bg-[#F6F0ED] p-4 text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0d6370] ${disabled ? 'cursor-not-allowed' : ''}`}>
      <span className="text-sm font-semibold text-[#326273]">{label}</span>
      <span aria-hidden="true" className={`h-6 w-11 rounded-full p-1 transition-colors ${active ? 'bg-[#5C9EAD]' : 'bg-[#326273]/20'}`}>
        <span className={`block h-4 w-4 rounded-full bg-white transition-transform ${active ? 'translate-x-5' : ''}`} />
      </span>
    </button>
  );
}
