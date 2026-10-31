'use client';

import { useCallback, useState } from 'react';
import Link from 'next/link';
import { Lock, RefreshCw } from 'lucide-react';

import ApprovalsInbox from '@/components/approvals/ApprovalsInbox';
import DashPageHeader from '@/components/dashboard/DashPageHeader';
import { QuietButton } from '@/components/transfer/ui';
import AlertsCard from '@/components/wallet/AlertsCard';
import FundingSources from '@/components/wallet/FundingSources';
import SignersCard from '@/components/wallet/SignersCard';
import SigningInbox from '@/components/wallet/SigningInbox';
import { Card, Loading, Note, useLoad } from '@/components/wallet/parts';
import type { FundingOptions, Overview } from '@/components/wallet/types';
import type { GovernanceBannerAlert } from '@/lib/server/governance-events';
import type { SpendWire } from '@/lib/team-rules/view';
import AboutCard from './AboutCard';
import ApprovalChannelCard from './ApprovalChannelCard';
import BillingCard from './BillingCard';
import OperatingControls, { OperatingControlsUnavailable, useOperatingSettings } from './OperatingControls';
import PolicyCard from './PolicyCard';
import RulesSection from './RulesSection';
import TeamCard from './TeamCard';
import type { StaffChoice } from './RuleForm';

const SECTIONS: Array<{ id: string; label: string }> = [
  { id: 'team', label: 'Team' },
  { id: 'rules', label: 'Spending rules' },
  { id: 'signers', label: 'Signers' },
  { id: 'funding', label: 'Funding sources' },
  { id: 'approvals', label: 'Approvals' },
  { id: 'alerts', label: 'Upgrade alerts' },
  { id: 'controls', label: 'Controls' },
  { id: 'about', label: 'How Splash operates' },
];

/**
 * Settings (v2 brief 5.9): the business's team and spending rules, who signs
 * for the wallet, where funds may come from, how approvers are reached, what
 * Splash has announced, and the operating controls. The rules, the policy and
 * the signers are the §4.2 and §4.1 backend: an owner's change is a request the
 * owners sign on their own devices and takes effect at once; Splash's own
 * changes keep a 24-hour notice (Upgrade alerts). Billing is built behind its
 * switch and shown only when it is on.
 *
 * Every section reads the signed-in person's own business and none takes a
 * business, a wallet or an address from the page.
 */
export default function SettingsPage({ alerts, billingOn }: { alerts: GovernanceBannerAlert[]; billingOn: boolean }) {
  const overview = useLoad<Overview>('/api/wallet/overview', 'Your wallet could not be read.');
  const ready = overview.data?.walletState === 'ready';
  const spend = useLoad<SpendWire>(ready ? '/api/wallet/spending-rules' : null, 'The spending rules could not be read.');
  const funding = useLoad<FundingOptions>(ready ? '/api/wallet/funding' : null, 'Your funding options could not be loaded.');
  const team = useLoad<{ members: Array<{ userId: string; name: string; role: string }> }>('/api/wallet/persons-in-charge', 'The team could not be loaded.');
  const ops = useOperatingSettings();
  const [, setVersion] = useState(0);
  const { reload: reloadOverview } = overview;
  const { reload: reloadSpend } = spend;
  const { reload: reloadFunding } = funding;
  const changed = useCallback(() => {
    reloadOverview();
    reloadSpend();
    reloadFunding();
    setVersion((v) => v + 1);
  }, [reloadOverview, reloadSpend, reloadFunding]);

  const o = overview.data;
  const owner = o?.role === 'OWNER';
  const nav = billingOn ? [...SECTIONS.slice(0, 6), { id: 'billing', label: 'Billing' }, ...SECTIONS.slice(6)] : SECTIONS;
  const view = spend.data;
  const staff: StaffChoice[] = (team.data?.members ?? [])
    .filter((m) => m.role === 'maker' || m.role === 'checker')
    .map((m) => ({ userId: m.userId, name: m.name, role: m.role, hasRule: Boolean(view?.rules.some((r) => r.userId === m.userId)) }));

  const header = (
    <DashPageHeader
      kicker="Your business"
      title="Settings"
      description="Your team and their spending rules, who signs for the wallet, where funds may come from, and how approvals reach you."
    />
  );

  const walletNote = (what: string) => {
    if (overview.loading) return <Loading label="Reading your wallet…" />;
    if (!o) {
      return (
        <div className="space-y-3">
          <Note tone="error">{overview.error}</Note>
          <QuietButton type="button" onClick={overview.reload}><RefreshCw className="h-4 w-4" aria-hidden="true" />Try again</QuietButton>
        </div>
      );
    }
    if (o.walletState === 'off') return <p role="status" className="flex items-start gap-2 text-[13px] leading-5 text-[#1F4452]"><Lock className="mt-0.5 h-4 w-4 shrink-0 text-[var(--warn-ink)]" aria-hidden="true" />Business wallets are not open for your workspace yet, so there are no {what} to manage. Your Splash contact will tell you when they are.</p>;
    if (o.walletState === 'unavailable') return <Note tone="error">Splash could not reach the chain to read your wallet. Nothing was changed.</Note>;
    if (o.walletState === 'pending') return <Note>Your business wallet is being set up. Each owner signs the next step on their own device, under Needs your signature on the Wallet page.</Note>;
    return <Note>You have no business wallet yet. {owner ? <>An owner creates it on the <Link href="/dashboard/wallet" className="font-semibold underline">Wallet page</Link>; {what} are managed here after that.</> : `An owner creates it; ${what} appear here after that.`}</Note>;
  };

  return (
    <div className="mx-auto w-full max-w-6xl space-y-5">
      {header}

      <nav aria-label="Settings sections" className="-mx-1 overflow-x-auto px-1">
        <ul className="flex min-w-max gap-2 pb-1 sm:min-w-0 sm:flex-wrap">
          {nav.map((s) => (
            <li key={s.id}>
              <a href={`#${s.id}`} className="inline-flex min-h-10 items-center rounded-xl border border-[#326273]/20 bg-white px-3 text-[13px] font-semibold text-[#1F4452] transition-colors hover:border-[#0d6370]/60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0d6370]">{s.label}</a>
            </li>
          ))}
        </ul>
      </nav>

      <SigningInbox onChanged={changed} />

      <div className="grid items-start gap-5 xl:grid-cols-[1.35fr_1fr]">
        <div className="space-y-5">
          <TeamCard owner={owner === true} spend={view} />
          {ready && view ? (
            <>
              <PolicyCard owner={owner === true} spend={view} onChanged={changed} />
              <RulesSection owner={owner === true} spend={view} staff={staff} onChanged={changed} />
            </>
          ) : (
            <>
              <Card id="policy" title="Spending policy">{spend.error && ready ? <Note tone="error">{spend.error}</Note> : ready ? <Loading label="Reading the rules from the chain…" /> : walletNote('spending rules')}</Card>
              <Card id="rules" title="Spending rules">{spend.error && ready ? <Note tone="error">{spend.error}</Note> : ready ? <Loading label="Reading the rules from the chain…" /> : walletNote('spending rules')}</Card>
            </>
          )}
          {billingOn ? <BillingCard owner={owner === true} /> : null}
          {ops.settings ? <OperatingControls settings={ops.settings} setSettings={ops.setSettings} /> : ops.problem ? <OperatingControlsUnavailable problem={ops.problem} /> : <Card id="controls" title="Operating controls"><Loading label="Reading your controls…" /></Card>}
        </div>

        <aside className="space-y-5">
          {ready && o ? <SignersCard overview={o} onChanged={changed} /> : <Card id="signers" title="Signers and threshold">{walletNote('signers')}</Card>}
          <div id="funding" className="scroll-mt-24">
            {ready && funding.data ? (
              <FundingSources funding={funding.data} owner={owner === true} onChanged={changed} />
            ) : (
              <Card title="Funding sources">{ready ? (funding.error ? <Note tone="error">{funding.error}</Note> : <Loading label="Loading…" />) : walletNote('funding sources')}</Card>
            )}
          </div>
          <div id="approvals" className="scroll-mt-24 space-y-5">
            {ops.settings ? (
              <ApprovalChannelCard whatsappEnabled={ops.settings.whatsappEnabled} approvalChannel={ops.settings.approvalChannel} onChange={(patch) => ops.setSettings((current) => (current ? { ...current, ...patch } : current))} />
            ) : null}
            <ApprovalsInbox />
          </div>
          <div id="alerts" className="scroll-mt-24">
            <AlertsCard alerts={alerts} owner={owner === true} />
          </div>
        </aside>
      </div>

      <AboutCard />
    </div>
  );
}
