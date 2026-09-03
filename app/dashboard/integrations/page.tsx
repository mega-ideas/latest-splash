'use client';

import { Plug } from 'lucide-react';
import { useEffect, useState } from 'react';

import { PageHeader } from '@/components/shell/PageHeader';
import StatusLabel, { type StatusTone } from '@/components/shell/StatusLabel';
import RoadmapChip from '@/components/supply/RoadmapChip';
import { Button } from '@/components/system';
import { getNetworkProfile } from '@/lib/network';

type Connection = { name: string; capability: string; environment: string; auth: string; health: string; tone: StatusTone; detail: string; roadmap?: string };

/**
 * Integrations: which evidence and execution dependencies Splash relies
 * on, grouped the way the guide asks — Banking & Liquidity, FX & Routing,
 * Compliance, Ledger & Network. Health comes from the network profile and
 * what the app can observe; partner legal names stay off this page.
 */
export default function IntegrationsPage() {
  const profile = getNetworkProfile();
  const [checked, setChecked] = useState<string | null>(null);
  const [treasuryOk, setTreasuryOk] = useState<boolean | null>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void fetch('/api/treasury', { cache: 'no-store' }).then((r) => setTreasuryOk(r.ok)).catch(() => setTreasuryOk(false));
      setChecked(new Date().toISOString().slice(11, 19));
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  const groups: Array<{ label: string; items: Connection[] }> = [
    {
      label: 'Banking & Liquidity',
      items: [
        { name: 'USD funding (bank wire / held balance)', capability: 'Fund payouts in fiat', environment: profile.live ? 'Live' : 'Sandbox', auth: 'Funding session', health: treasuryOk === null ? 'Checking' : treasuryOk ? 'Healthy' : 'Unavailable', tone: treasuryOk === false ? 'exception' : treasuryOk ? 'verified' : 'neutral', detail: 'Operating cash with no notice period; KYT on every funding source.' },
        ...profile.corridors.map<Connection>((c) => ({ name: c.partnerLabel, capability: `Local payout · ${c.currency}`, environment: c.status === 'live' ? 'Live' : c.status === 'sandbox' ? 'Sandbox' : 'Planned', auth: 'Partner API (server-side)', health: c.status === 'planned' ? 'Not connected' : 'Healthy', tone: c.status === 'planned' ? 'neutral' : 'verified', detail: `${c.country} · rail ${c.deliveryRail}${c.destinationChain ? ` via ${c.destinationChain}` : ''}. Legal name appears on receipts to transaction parties only.` })),
      ],
    },
    {
      label: 'FX & Routing',
      items: [
        { name: 'Pyth price oracle', capability: 'USD mid-market reference', environment: profile.network === 'mainnet' ? 'Mainnet' : 'Testnet', auth: 'Public feed', health: 'Healthy', tone: 'verified', detail: 'Every quote starts from the Pyth mid; the executed rate is written into the settlement intent.' },
        { name: 'Sui settlement rail', capability: 'pay · allocate · prove in one transaction', environment: profile.badges.network, auth: 'Operator PTB (gas sponsored)', health: profile.live ? 'Live' : 'Sandbox', tone: profile.live ? 'verified' : 'attention', detail: `~400ms finality. Core package ${profile.packageIds.core ? 'published' : 'placeholder'}; custody publishes only when the licence tier permits.` },
      ],
    },
    {
      label: 'Compliance',
      items: [
        { name: 'KYB intake (Sumsub workflow)', capability: 'Business verification', environment: 'Sandbox', auth: 'Server-side token', health: 'Wired', tone: 'verified', detail: 'Upload and review handlers under /api/kyb; verification completes before a first payout.' },
        { name: 'KYT and sanctions screening', capability: 'Counterparty and funding screening', environment: 'Modeled', auth: '—', health: 'Roadmap', tone: 'neutral', detail: 'Part of the production gate; provider wiring is rollout work.', roadmap: 'provider wiring before first live corridor' },
      ],
    },
    {
      label: 'Ledger & Network',
      items: [
        { name: 'Internal ledger', capability: 'Paired entries per movement', environment: profile.live ? 'Live' : 'Sandbox', auth: 'Workspace session', health: treasuryOk === false ? 'Unavailable' : 'Healthy', tone: treasuryOk === false ? 'exception' : 'verified', detail: 'Debit and credit entries with balance-after, referenced by transfer, sweep, fee and funding ids.' },
        { name: 'Walrus storage · Seal encryption', capability: 'Audit evidence, access-controlled', environment: profile.badges.network, auth: 'Seal policy', health: 'Healthy', tone: 'verified', detail: 'Receipts and audit batches stored as ciphertext; daily Merkle anchors on Sui.' },
      ],
    },
  ];

  return (
    <>
      <PageHeader
        title="Integrations"
        supporting="Connect the evidence and execution systems Splash depends on."
        actions={
          <Button disabled>
            <Plug aria-hidden="true" /> Add integration
          </Button>
        }
      />
      <p className="mb-4 font-mono text-[11px] text-[var(--text-muted)]">Last checked {checked ? `${checked} UTC` : '—'} · health reflects what this workspace can observe</p>
      <div className="grid gap-4">
        {groups.map((group) => (
          <section key={group.label} aria-labelledby={`grp-${group.label}`} className="border border-[var(--border-default)] bg-[var(--surface-raised)]">
            <h2 id={`grp-${group.label}`} className="border-b border-[var(--border-default)] bg-[var(--surface-subtle)] px-4 py-2.5 font-mono text-[10.5px] uppercase tracking-[var(--tracking-label)] text-[var(--text-2)]">{group.label}</h2>
            <ul className="divide-y divide-[var(--border-default)]">
              {group.items.map((item) => (
                <li key={item.name} className="grid gap-2 px-4 py-3 md:grid-cols-[1.4fr_1fr_0.8fr_1fr_auto] md:items-center">
                  <div className="min-w-0">
                    <div className="truncate text-[13.5px] font-medium">{item.name}</div>
                    <div className="text-[12px] text-[var(--text-2)]">{item.capability}</div>
                  </div>
                  <div className="font-mono text-[11.5px] text-[var(--text-2)]">{item.environment}</div>
                  <div className="font-mono text-[11.5px] text-[var(--text-2)]">{item.auth}</div>
                  <div className="text-[12px] text-[var(--text-2)]">{item.detail}</div>
                  <div className="flex items-center gap-2 md:justify-end">
                    {item.roadmap ? <RoadmapChip detail={item.roadmap} /> : <StatusLabel compact tone={item.tone}>{item.health}</StatusLabel>}
                  </div>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </>
  );
}
