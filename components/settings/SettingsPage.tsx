'use client';

import { useCallback, type ReactNode } from 'react';
import Link from 'next/link';
import { Lock, RefreshCw } from 'lucide-react';

import ApprovalsInbox from '@/components/approvals/ApprovalsInbox';
import DashPageHeader from '@/components/dashboard/DashPageHeader';
import { QuietButton } from '@/components/transfer/ui';
import AlertsCard from '@/components/wallet/AlertsCard';
import FundingSources from '@/components/wallet/FundingSources';
import type { InCharge } from '@/components/wallet/Migration';
import SignersCard from '@/components/wallet/SignersCard';
import SigningInbox from '@/components/wallet/SigningInbox';
import { Card, Loading, Note, useLoad } from '@/components/wallet/parts';
import type { FundingOptions, Overview } from '@/components/wallet/types';
import type { GovernanceBannerAlert } from '@/lib/server/governance-events';
import { canEditControls } from '@/lib/settings-page/controls';
import { settingsWallet } from '@/lib/settings-page/wallet-gate';
import { explainSpendFailure } from '@/lib/team-rules/states';
import type { SpendWire } from '@/lib/team-rules/view';
import type { TeamWire } from '@/lib/team/view';
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

/** The sections that need a business wallet: with none, they are one card and not in the list of links. */
const NEEDS_WALLET = new Set(['rules', 'signers', 'funding']);

/**
 * Settings (v2 brief 5.9): the business's team and spending rules, who signs
 * for the wallet, where funds may come from, how approvers are reached, what
 * Splash has announced, and the operating controls. The rules, the policy and
 * the signers are the §4.2 and §4.1 backend: an owner's change is a request the
 * owners sign on their own devices and takes effect at once; Splash's own
 * changes keep a 24-hour notice (Upgrade alerts). Billing is built behind its
 * switch and shown only when it is on.
 *
 * With no business wallet the page says so once, in one card, and shows what
 * does not need a wallet (approvals, alerts, controls). Every section reads the
 * signed-in person's own business and none takes a business, a wallet or an
 * address from the page.
 */
export default function SettingsPage({ alerts, billingOn }: { alerts: GovernanceBannerAlert[]; billingOn: boolean }) {
  const overview = useLoad<Overview>('/api/wallet/overview', 'Your wallet could not be read.');
  const wallet = settingsWallet(overview.data?.walletState);
  const { manage } = wallet;
  const spend = useLoad<SpendWire>(manage ? '/api/wallet/spending-rules' : null, 'The spending rules could not be read.', explainSpendFailure);
  const funding = useLoad<FundingOptions>(manage ? '/api/wallet/funding' : null, 'Your funding options could not be loaded.');
  const charge = useLoad<InCharge>(manage ? '/api/wallet/persons-in-charge' : null, 'The people in charge could not be loaded.');
  // The team is the database's, not the chain's: it is managed here before a business wallet exists too.
  const people = useLoad<TeamWire>('/api/team', 'The team could not be loaded.');
  const ops = useOperatingSettings();
  const { reload: reloadOverview } = overview;
  const { reload: reloadSpend } = spend;
  const { reload: reloadFunding } = funding;
  const { reload: reloadCharge } = charge;
  const changed = useCallback(() => {
    reloadOverview();
    reloadSpend();
    reloadFunding();
    reloadCharge();
  }, [reloadOverview, reloadSpend, reloadFunding, reloadCharge]);

  const o = overview.data;
  const owner = o?.role === 'OWNER';
  const nav = SECTIONS.filter((s) => manage || !NEEDS_WALLET.has(s.id));
  if (billingOn) nav.splice(nav.findIndex((s) => s.id === 'alerts') + 1, 0, { id: 'billing', label: 'Billing' });
  const view = spend.data;
  const staff: StaffChoice[] = (charge.data?.members ?? [])
    .filter((m) => m.role === 'maker' || m.role === 'checker')
    .map((m) => ({ userId: m.userId, name: m.name, role: m.role, hasRule: Boolean(view?.rules.some((r) => r.userId === m.userId)), hasPasskey: m.hasPasskey }));

  const header = (
    <DashPageHeader
      kicker="Your business"
      title="Settings"
      description="Your team and what each person may do, their spending rules, who signs for the wallet, where funds may come from, and how approvals reach you."
    />
  );

  /** What to say about the wallet, once: it is being read, it is not open, it is not set up, or it is being set up. */
  const walletNote = (): ReactNode => {
    switch (wallet.note) {
      case 'loading':
        return overview.error ? (
          <div className="space-y-3">
            <Note tone="error">{overview.error}</Note>
            <QuietButton type="button" onClick={overview.reload}><RefreshCw className="h-4 w-4" aria-hidden="true" />Try again</QuietButton>
          </div>
        ) : <Loading label="Reading your wallet…" />;
      case 'off':
        return <p role="status" className="flex items-start gap-2 text-[13px] leading-5 text-[#1F4452]"><Lock className="mt-0.5 h-4 w-4 shrink-0 text-[var(--warn-ink)]" aria-hidden="true" />Business wallets are not open for your workspace yet, so there is no team to give spending rules to, no signers and no funding sources to manage. Your Splash contact will tell you when they are.</p>;
      case 'unavailable':
        return <Note tone="error">Splash could not reach the chain to read your wallet. Nothing was changed.</Note>;
      case 'pending':
        return <Note>Your business wallet is being set up. Each owner signs the next step on their own device, under Needs your signature above or on the Wallet page. Rules, signers and funding sources are managed here after that.</Note>;
      default:
        return <Note>You have no business wallet yet. {owner ? <>An owner creates it on the <Link href="/dashboard/wallet" className="font-semibold underline">Wallet page</Link>; the team&rsquo;s spending rules, signers and funding sources are managed here after that.</> : 'An owner creates it; the team’s spending rules, signers and funding sources appear here after that.'}</Note>;
    }
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

      {wallet.inbox ? <SigningInbox onChanged={changed} /> : null}

      <div className="grid grid-cols-[minmax(0,1fr)] items-start gap-5 xl:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
        <div className="min-w-0 space-y-5">
          <TeamCard people={people} charge={charge} spend={view} walletReady={manage} onChanged={changed} />
          {manage ? (
            <>
              {view ? <PolicyCard owner={owner === true} spend={view} onChanged={changed} /> : null}
              <RulesSection owner={owner === true} spend={view} loading={spend.loading} error={spend.error} onRetry={spend.reload} staff={staff} staffLoading={charge.loading} staffError={charge.error} onRetryStaff={charge.reload} onChanged={changed} />
            </>
          ) : (
            <Card id="wallet-note" title="Spending rules, signers and funding">{walletNote()}</Card>
          )}
          {billingOn ? <BillingCard owner={owner === true} /> : null}
          {ops.settings ? <OperatingControls settings={ops.settings} setSettings={ops.setSettings} editable={canEditControls(o?.role)} /> : ops.problem ? <OperatingControlsUnavailable problem={ops.problem} /> : <Card id="controls" title="Operating controls"><Loading label="Reading your controls…" /></Card>}
        </div>

        <aside className="min-w-0 space-y-5">
          {manage && o ? <SignersCard overview={o} onChanged={changed} /> : null}
          {manage ? (
            <div id="funding" className="scroll-mt-24">
              {funding.data ? (
                <FundingSources funding={funding.data} owner={owner === true} onChanged={changed} />
              ) : (
                <Card title="Funding sources">{funding.error ? <Note tone="error">{funding.error}</Note> : <Loading label="Loading…" />}</Card>
              )}
            </div>
          ) : null}
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
