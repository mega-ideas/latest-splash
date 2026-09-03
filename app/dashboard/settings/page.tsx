'use client';

import { Bell, Building2, Download, KeyRound, ShieldCheck, SlidersHorizontal, UserRound } from 'lucide-react';
import { useEffect, useState, type ComponentType, type SVGProps } from 'react';
import { toast } from 'sonner';

import RoadmapChip from '@/components/supply/RoadmapChip';
import { Badge, Button, Card, Chip, ProofRow, Skeleton } from '@/components/system';
import { brand } from '@/lib/brand';
import { formatInstant } from '@/lib/format/time';
import { getNetworkProfile } from '@/lib/network';
import { cn } from '@/lib/utils';

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

type Session = { name: string; email: string; organization: string };

type TabId = 'policies' | 'profile' | 'org' | 'notifications' | 'exports' | 'security';

const TABS: Array<{ id: TabId; label: string; icon: ComponentType<SVGProps<SVGSVGElement>> }> = [
  { id: 'policies', label: 'Policies', icon: SlidersHorizontal },
  { id: 'profile', label: 'Profile', icon: UserRound },
  { id: 'org', label: 'Org & signers', icon: Building2 },
  { id: 'notifications', label: 'Notifications', icon: Bell },
  { id: 'exports', label: 'Exports & integrations', icon: Download },
  { id: 'security', label: 'Security', icon: KeyRound },
];

const usd = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

/**
 * Settings: one page, six tabs. Policies, notifications and security write
 * the same persisted operating controls the approval path enforces; profile
 * and organisation are read here and edited through their own reviewed
 * flows; exports point at the surfaces that already produce CSVs.
 */
export default function DashboardSettingsPage() {
  const [tab, setTab] = useState<TabId>('policies');
  const [settings, setSettings] = useState<Settings | null>(null);
  const [draft, setDraft] = useState<Settings | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [saving, setSaving] = useState(false);
  const corridors = getNetworkProfile().corridors;

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const requested = new URLSearchParams(window.location.search).get('tab');
      if (requested && TABS.some((entry) => entry.id === requested)) setTab(requested as TabId);
      void fetch('/api/settings', { cache: 'no-store' })
        .then((response) => response.json())
        .then((body: Settings) => {
          setSettings(body);
          setDraft(body);
        });
      void fetch('/api/auth/session', { cache: 'no-store' })
        .then((response) => (response.ok ? response.json() : null))
        .then((body: Session | null) => setSession(body));
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  function selectTab(next: TabId) {
    setTab(next);
    const url = new URL(window.location.href);
    url.searchParams.set('tab', next);
    window.history.replaceState(null, '', url);
  }

  function update<K extends keyof Settings>(key: K, value: Settings[K]) {
    setDraft((current) => (current ? { ...current, [key]: value } : current));
  }

  const dirty = Boolean(settings && draft && JSON.stringify(settings) !== JSON.stringify(draft));

  async function save() {
    if (!draft) return;
    setSaving(true);
    try {
      const response = await fetch('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(draft) });
      const body = (await response.json()) as Settings & { error?: string };
      if (!response.ok) throw new Error(body.error ?? 'Unable to save operating controls.');
      setSettings(body);
      setDraft(body);
      toast.success('Operating controls saved');
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : 'Unable to save operating controls.');
    } finally {
      setSaving(false);
    }
  }

  const saveBar = (
    <div className="flex flex-wrap items-center gap-3">
      <Button onClick={() => void save()} disabled={!dirty || saving}>
        {saving ? 'Saving…' : 'Save controls'}
      </Button>
      {dirty ? (
        <Button variant="ghost" onClick={() => setDraft(settings)}>
          Discard changes
        </Button>
      ) : null}
      <span className="text-[12px] text-[var(--text-muted)]">
        {settings ? (new Date(settings.updatedAt).getTime() === 0 ? 'Using policy defaults' : `Last saved ${formatInstant(settings.updatedAt)}`) : ''}
      </span>
    </div>
  );

  return (
    <div className="grid gap-6">
      <header>
        <h1 className="text-[var(--text-h1)] font-semibold leading-[1.1] tracking-[-0.02em]">Settings</h1>
        <p className="mt-1 text-[14px] text-[var(--text-2)]">Operating controls the approval path enforces, plus who you are and how the workspace reaches you.</p>
      </header>

      <div role="tablist" aria-label="Settings sections" className="-mx-4 flex gap-1 overflow-x-auto px-4 pb-1 md:mx-0 md:px-0">
        {TABS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            role="tab"
            type="button"
            id={`tab-${id}`}
            aria-selected={tab === id}
            aria-controls={`panel-${id}`}
            onClick={() => selectTab(id)}
            className={cn(
              'flex h-10 shrink-0 items-center gap-2 rounded-full border px-3.5 text-[14px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-[var(--teal-100)]',
              tab === id ? 'border-[var(--ink-900)] bg-[var(--ink-900)] text-white' : 'border-[var(--line)] bg-[var(--surface)] text-[var(--text-2)] hover:bg-[var(--surface-2)]',
            )}
          >
            <Icon className="size-4" aria-hidden="true" />
            {label}
          </button>
        ))}
      </div>

      <section role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`} className="grid gap-4">
        {tab === 'policies' ? (
          <>
            <Card className="grid gap-4">
              <div>
                <h2 className="text-[15px] font-semibold">Payment controls</h2>
                <p className="text-[13px] text-[var(--text-muted)]">Limits are enforced server-side on every proposal and re-checked at submit.</p>
              </div>
              {draft ? (
                <div className="grid gap-4 md:grid-cols-2">
                  <MoneyField label="Per-transfer limit" value={draft.perTransferLimitUsd} onChange={(value) => update('perTransferLimitUsd', value)} helper="No single payout above this leaves the desk without a policy exception." />
                  <MoneyField label="Daily limit" value={draft.dailyLimitUsd} onChange={(value) => update('dailyLimitUsd', value)} helper="Rolling 24 hours, summed from the ledger." />
                  <MoneyField label="Maker-checker threshold" value={draft.approvalThresholdUsd} onChange={(value) => update('approvalThresholdUsd', value)} helper="Above this a second, distinct approver is required." />
                  <label className="grid gap-1 text-[14px] font-semibold">
                    Treasury auto-allocation
                    <span className="flex h-11 items-center rounded-[var(--r-sm)] border border-[var(--line)] bg-[var(--surface)] px-3">
                      <input type="number" min={0} max={100} value={draft.autoAllocateTreasuryPct} onChange={(event) => update('autoAllocateTreasuryPct', Number(event.target.value) || 0)} className="min-w-0 flex-1 bg-transparent font-mono text-[16px] tabular-nums outline-none" />
                      <span className="font-mono text-[12px] text-[var(--text-muted)]">% of idle</span>
                    </span>
                    <span className="text-[12px] font-normal text-[var(--text-muted)]">{brand.agentName} proposes a sweep of this share of idle balance; a human still approves it.</span>
                  </label>
                </div>
              ) : (
                <Skeleton variant="text" lines={4} />
              )}
              {saveBar}
            </Card>
            <Card tone="tint" className="grid gap-2">
              <h2 className="text-[15px] font-semibold">Corridor allowlist</h2>
              <div className="flex flex-wrap gap-1.5">
                {corridors.map((corridor) => (
                  <Chip key={corridor.code} tone="teal">
                    {corridor.partnerLabel}
                  </Chip>
                ))}
              </div>
              <p className="text-[12px] text-[var(--text-muted)]">Payouts settle only to enabled corridors. Partner names appear on receipts to the parties of a transaction, not here.</p>
            </Card>
          </>
        ) : null}

        {tab === 'profile' ? (
          <Card className="grid gap-4">
            <div>
              <h2 className="text-[15px] font-semibold">Your profile</h2>
              <p className="text-[13px] text-[var(--text-muted)]">Identity fields change through a reviewed request so approvals stay attributable.</p>
            </div>
            {session ? (
              <dl>
                <ProofRow label="Name" value={session.name} />
                <ProofRow label="Sign-in email" value={<span className="font-mono">{session.email}</span>} />
                <ProofRow label="Organisation" value={session.organization} />
                <ProofRow label="Role" value={<Badge tone="teal">Approver</Badge>} />
              </dl>
            ) : (
              <Skeleton variant="text" lines={4} />
            )}
            <Button variant="ghost" href="/dashboard/profile" className="justify-self-start">
              Edit profile & review history
            </Button>
          </Card>
        ) : null}

        {tab === 'org' ? (
          <div className="grid gap-4 lg:grid-cols-2">
            <Card className="grid gap-4">
              <div>
                <h2 className="text-[15px] font-semibold">Organisation</h2>
                <p className="text-[13px] text-[var(--text-muted)]">The workspace every proposal, approval and receipt is scoped to.</p>
              </div>
              {session ? (
                <dl>
                  <ProofRow label="Workspace" value={session.organization} />
                  <ProofRow label="Legal entity on receipts" value={brand.legalEntity} />
                  <ProofRow label="Corridors" value={corridors.map((corridor) => corridor.currency).join(' · ')} />
                </dl>
              ) : (
                <Skeleton variant="text" lines={3} />
              )}
              <Button variant="ghost" href="/settings/kyb" className="justify-self-start">
                Business verification (KYB)
              </Button>
            </Card>
            <Card className="grid gap-4">
              <div>
                <h2 className="text-[15px] font-semibold">Signers</h2>
                <p className="text-[13px] text-[var(--text-muted)]">Who can approve. Maker and checker must be different people.</p>
              </div>
              {session && draft ? (
                <ul className="grid gap-2">
                  <li className="flex items-center justify-between gap-3 rounded-[var(--r-sm)] border border-[var(--line)] px-3 py-2.5">
                    <span className="grid">
                      <span className="text-[14px] font-medium">{session.name}</span>
                      <span className="font-mono text-[12px] text-[var(--text-muted)]">{session.email}</span>
                    </span>
                    <Badge tone="green">You · approver</Badge>
                  </li>
                  <li className="rounded-[var(--r-sm)] border border-dashed border-[var(--line)] px-3 py-2.5 text-[13px] text-[var(--text-muted)]">
                    {draft.requireDualApproval
                      ? `Dual approval is on above ${usd.format(draft.approvalThresholdUsd)} USD. A second signer is required for those proposals.`
                      : 'Dual approval is off. Turn it on under Security to require a second signer.'}
                  </li>
                </ul>
              ) : (
                <Skeleton variant="text" lines={3} />
              )}
              <div className="flex flex-wrap items-center gap-2">
                <Button variant="ghost" disabled>
                  Invite a signer
                </Button>
                <RoadmapChip detail="signer invitations ship with workspace roles" />
              </div>
            </Card>
          </div>
        ) : null}

        {tab === 'notifications' ? (
          <Card className="grid gap-4">
            <div>
              <h2 className="text-[15px] font-semibold">Notifications</h2>
              <p className="text-[13px] text-[var(--text-muted)]">Where the workspace reaches you when money settles or needs a decision.</p>
            </div>
            {draft ? (
              <div className="grid gap-2">
                <Switch label="Settlement notifications" description="An email when a payout settles or is returned." checked={draft.notifyOnSettlement} onChange={(value) => update('notifyOnSettlement', value)} />
                <Row label="Approval requests" value={<Badge tone="green">In-app · always on</Badge>} />
                <Row label="Webhooks" value={<RoadmapChip detail="after first live corridor" />} />
              </div>
            ) : (
              <Skeleton variant="text" lines={3} />
            )}
            {saveBar}
          </Card>
        ) : null}

        {tab === 'exports' ? (
          <div className="grid gap-4 lg:grid-cols-2">
            <Card className="grid gap-4">
              <div>
                <h2 className="text-[15px] font-semibold">Exports</h2>
                <p className="text-[13px] text-[var(--text-muted)]">CSV exports come from the table you are looking at, filtered the way you filtered it.</p>
              </div>
              <div className="grid gap-2">
                <Row label="Receipts" value={<Button variant="ghost" size="sm" href="/dashboard/receipts">Open receipts</Button>} />
                <Row label="Recipients" value={<Button variant="ghost" size="sm" href="/dashboard/recipients">Open recipients</Button>} />
                <Row label="Approvals history" value={<Button variant="ghost" size="sm" href="/dashboard/approvals">Open approvals</Button>} />
              </div>
            </Card>
            <Card className="grid gap-4">
              <div>
                <h2 className="text-[15px] font-semibold">Integrations</h2>
                <p className="text-[13px] text-[var(--text-muted)]">Programmatic access follows the first live corridor.</p>
              </div>
              <div className="grid gap-2">
                <Row label="API keys" value={<RoadmapChip detail="developer console after first live corridor" />} />
                <Row label="Accounting sync" value={<RoadmapChip detail="on the roadmap" />} />
                <Row label="Sandbox" value={<Button variant="ghost" size="sm" href="/sandbox">Open sandbox</Button>} />
              </div>
              <Button variant="ghost" href="/docs" className="justify-self-start">
                Read the docs
              </Button>
            </Card>
          </div>
        ) : null}

        {tab === 'security' ? (
          <div className="grid gap-4 lg:grid-cols-[1.1fr_0.9fr]">
            <Card className="grid gap-4">
              <div>
                <h2 className="text-[15px] font-semibold">Approval security</h2>
                <p className="text-[13px] text-[var(--text-muted)]">Enforced on the server for every proposal; the client cannot loosen them.</p>
              </div>
              {draft ? (
                <div className="grid gap-2">
                  <Switch label="TOTP on approval" description="Approvers confirm each signature with a one-time code." checked={draft.requireTotp} onChange={(value) => update('requireTotp', value)} />
                  <Switch label="Dual approval above threshold" description={`Two distinct approvers above ${usd.format(draft.approvalThresholdUsd)} USD.`} checked={draft.requireDualApproval} onChange={(value) => update('requireDualApproval', value)} />
                  <Switch label="Block high-risk corridors" description="Routes outside the allowlist fail preflight and again at submit." checked={draft.blockHighRiskCorridors} onChange={(value) => update('blockHighRiskCorridors', value)} />
                </div>
              ) : (
                <Skeleton variant="text" lines={3} />
              )}
              {saveBar}
            </Card>
            <Card tone="tint" className="grid gap-3">
              <div className="flex items-center gap-2">
                <ShieldCheck className="size-4 text-[var(--teal-600)]" aria-hidden="true" />
                <h2 className="text-[15px] font-semibold">How {brand.name} operates</h2>
              </div>
              <dl>
                <ProofRow label="Custody" value="Licensed partners are the system of record for customer funds" />
                <ProofRow label="Status" value="Not yet a licensed money-services business" />
                <ProofRow label="Records" value="Seal + Walrus, daily Merkle batches" />
                <ProofRow label="Agent" value={`${brand.agentName} proposes · human approves`} />
              </dl>
              <p className="text-[12px] text-[var(--text-muted)]">{brand.postureLine}</p>
            </Card>
          </div>
        ) : null}
      </section>
    </div>
  );
}

function MoneyField({ label, value, helper, onChange }: { label: string; value: number; helper: string; onChange: (value: number) => void }) {
  return (
    <label className="grid min-w-0 gap-1 text-[14px] font-semibold">
      {label}
      <span className="flex h-11 min-w-0 items-center rounded-[var(--r-sm)] border border-[var(--line)] bg-[var(--surface)] px-3 focus-within:border-[var(--teal-600)]">
        <input type="number" min={1} inputMode="numeric" value={value} onChange={(event) => onChange(Number(event.target.value) || 0)} className="min-w-0 flex-1 bg-transparent font-mono text-[16px] tabular-nums outline-none" />
        <span className="font-mono text-[12px] text-[var(--text-muted)]">USD</span>
      </span>
      <span className="text-[12px] font-normal text-[var(--text-muted)]">{helper}</span>
    </label>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex min-h-12 items-center justify-between gap-3 rounded-[var(--r-sm)] border border-[var(--line)] px-3 py-2">
      <span className="text-[14px] font-medium">{label}</span>
      {value}
    </div>
  );
}

function Switch({ label, description, checked, onChange }: { label: string; description: string; checked: boolean; onChange: (value: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className="flex min-h-12 w-full items-center justify-between gap-3 rounded-[var(--r-sm)] border border-[var(--line)] px-3 py-2 text-left focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-[var(--teal-100)]"
    >
      <span className="grid">
        <span className="text-[14px] font-medium">{label}</span>
        <span className="text-[12px] text-[var(--text-muted)]">{description}</span>
      </span>
      <span className={cn('h-6 w-11 shrink-0 rounded-full p-1 transition-colors', checked ? 'bg-[var(--teal-600)]' : 'bg-[var(--line)]')} aria-hidden="true">
        <span className={cn('block size-4 rounded-full bg-white transition-transform', checked && 'translate-x-5')} />
      </span>
    </button>
  );
}
