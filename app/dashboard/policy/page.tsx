'use client';

import { FlaskConical, Plus } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import Inspector, { InspectorField, InspectorSection } from '@/components/shell/Inspector';
import { PageHeader, Workspace } from '@/components/shell/PageHeader';
import StatusLabel from '@/components/shell/StatusLabel';
import { Button } from '@/components/system';
import { formatInstant } from '@/lib/format/time';
import { formatMoney } from '@/lib/money';
import { getNetworkProfile } from '@/lib/network';
import { cn } from '@/lib/utils';

type Settings = {
  perTransferLimitUsd: number;
  dailyLimitUsd: number;
  approvalThresholdUsd: number;
  requireTotp: boolean;
  requireDualApproval: boolean;
  blockHighRiskCorridors: boolean;
  updatedAt: string;
};

type Rule = { id: string; priority: number; title: string; condition: string; action: string; owner: string; state: 'Active' | 'Inactive'; why: string };

/**
 * Policy engine: the operating controls the server enforces, rendered as
 * readable IF condition THEN action rules in evaluation order. Reading is
 * free; editing goes through Settings and the same persisted controls the
 * approval path re-checks at submit. The simulator previews the outcome
 * for a sample payment; the server decides.
 */
export default function PolicyPage() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [selectedId, setSelectedId] = useState<string>('threshold');
  const [testAmount, setTestAmount] = useState('12000');
  const corridors = getNetworkProfile().corridors;

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void fetch('/api/settings', { cache: 'no-store' }).then((r) => r.json()).then((body: Settings) => setSettings(body));
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  const rules = useMemo<Rule[]>(() => {
    if (!settings) return [];
    return [
      { id: 'beneficiary', priority: 1, title: 'Verified beneficiary is required', condition: 'Beneficiary verification status ≠ Verified', action: 'Block', owner: 'Compliance', state: 'Active', why: 'A payout only ever goes to a record on the beneficiary list with KYB complete.' },
      { id: 'corridor', priority: 2, title: 'Corridor allowlist', condition: `Destination ∉ {${corridors.map((c) => c.currency).join(', ')}}`, action: 'Block', owner: 'Network Ops', state: settings.blockHighRiskCorridors ? 'Active' : 'Inactive', why: 'Payouts settle only to enabled corridors; high-risk routes fail preflight and again at submit.' },
      { id: 'per-transfer', priority: 3, title: 'Per-transfer limit', condition: `Amount > ${formatMoney('USD', settings.perTransferLimitUsd)}`, action: 'Block', owner: 'Treasury Ops', state: 'Active', why: 'No single payout above the limit leaves the desk without a policy exception.' },
      { id: 'daily', priority: 4, title: 'Daily limit', condition: `Rolling 24h outflows + amount > ${formatMoney('USD', settings.dailyLimitUsd)}`, action: 'Block', owner: 'Treasury Ops', state: 'Active', why: 'Summed from the ledger, never from the client.' },
      { id: 'threshold', priority: 5, title: 'Maker-checker threshold', condition: `Amount ≥ ${formatMoney('USD', settings.approvalThresholdUsd)}`, action: settings.requireDualApproval ? 'Require one distinct checker' : 'Require checker (dual approval off)', owner: 'Treasury Ops', state: 'Active', why: 'The maker can never approve their own material request.' },
      { id: 'totp', priority: 6, title: 'TOTP on approval', condition: 'Approval decision submitted', action: 'Require one-time code', owner: 'Security', state: settings.requireTotp ? 'Active' : 'Inactive', why: 'Every signature is confirmed by the approver, not the session.' },
      { id: 'quote', priority: 7, title: 'Quote freshness', condition: 'Quote age > 30 seconds', action: 'Refresh quote', owner: 'Payments', state: 'Active', why: 'An expired quote is never executable; the desk disables creation and offers a refresh.' },
    ];
  }, [settings, corridors]);

  const selected = rules.find((r) => r.id === selectedId) ?? rules[0];

  const simulation = useMemo(() => {
    if (!settings) return null;
    const amount = Number.parseFloat(testAmount) || 0;
    const results = rules.map((rule) => {
      let outcome: 'Passed' | 'Approval required' | 'Failed' = 'Passed';
      if (rule.id === 'per-transfer' && amount > settings.perTransferLimitUsd) outcome = 'Failed';
      if (rule.id === 'daily' && amount > settings.dailyLimitUsd) outcome = 'Failed';
      if (rule.id === 'threshold' && amount >= settings.approvalThresholdUsd) outcome = 'Approval required';
      if (rule.state === 'Inactive') outcome = 'Passed';
      return { rule, outcome };
    });
    const failed = results.find((r) => r.outcome === 'Failed');
    const approval = results.find((r) => r.outcome === 'Approval required');
    return { results, verdict: failed ? 'Blocked' : approval ? 'Approval required' : 'Policy passed', reason: failed ? `Rule ${failed.rule.priority}: ${failed.rule.title}` : approval ? `Rule ${approval.rule.priority}: ${approval.rule.title}` : 'All active rules passed' };
  }, [rules, settings, testAmount]);

  return (
    <>
      <PageHeader
        title="Policy engine"
        supporting="Controls that travel with every payment."
        actions={
          <>
            <Button href="#simulator" variant="secondary">
              <FlaskConical aria-hidden="true" /> Test policy
            </Button>
            <Button href="/dashboard/settings?tab=policies">
              <Plus aria-hidden="true" /> Edit controls
            </Button>
          </>
        }
      />

      <Workspace
        inspector={
          selected ? (
            <Inspector kicker="Rule inspector" title={`${selected.priority} · ${selected.title}`} subtitle={<StatusLabel compact tone={selected.state === 'Active' ? 'verified' : 'neutral'}>{selected.state}</StatusLabel>}>
              <InspectorSection title="If (condition)">
                <p className="border border-[var(--border-default)] bg-[var(--surface-raised)] px-3 py-2 font-mono text-[12.5px]">{selected.condition}</p>
              </InspectorSection>
              <InspectorSection title="Then (action)">
                <p className="border border-[var(--border-default)] bg-[var(--surface-raised)] px-3 py-2 text-[13px] font-medium">{selected.action}</p>
                <p className="mt-2 text-[12px] text-[var(--text-2)]">{selected.why}</p>
              </InspectorSection>
              <InspectorSection title="Server enforcement">
                <div className="flex items-center gap-2 text-[12.5px]">
                  <StatusLabel compact tone="verified">Enforced by server</StatusLabel>
                  <span className="text-[var(--text-2)]">Applied at proposal and re-checked at submit.</span>
                </div>
              </InspectorSection>
              <InspectorSection title="Scope and version">
                <div className="grid grid-cols-2 gap-2">
                  <InspectorField label="Scope">All corridors</InspectorField>
                  <InspectorField label="Owner">{selected.owner}</InspectorField>
                  <InspectorField label="Version" mono>{settings ? `POL-${settings.updatedAt.slice(0, 10).replace(/-/g, '')}` : '—'}</InspectorField>
                  <InspectorField label="Last changed" mono>{settings ? (new Date(settings.updatedAt).getTime() === 0 ? 'defaults' : formatInstant(settings.updatedAt)) : '—'}</InspectorField>
                </div>
              </InspectorSection>
              <p className="mt-4 text-[12px] text-[var(--text-2)]">Draft changes are made in Settings and take effect only after they are saved by an approver; the policy engine never edits itself.</p>
              <div className="mt-3">
                <Button href="/dashboard/settings?tab=policies" variant="secondary" fullWidth>
                  Edit draft in Settings
                </Button>
              </div>
            </Inspector>
          ) : undefined
        }
      >
        <div className="flex items-center justify-between border-b border-[var(--border-default)] px-4 py-3">
          <span className="font-mono text-[10.5px] uppercase tracking-[var(--tracking-label)] text-[var(--text-2)]">Rules — operating controls</span>
          <span className="font-mono text-[11px] text-[var(--text-muted)]">{rules.length} rules · evaluated in priority order · first failing rule takes action</span>
        </div>
        <table className="w-full text-[12.5px]">
          <thead>
            <tr className="font-mono text-[10px] uppercase tracking-[var(--tracking-label)] text-[var(--text-muted)]">
              <th scope="col" className="h-10 px-3 text-left font-medium">Priority</th>
              <th scope="col" className="h-10 px-3 text-left font-medium">Rule</th>
              <th scope="col" className="h-10 px-3 text-left font-medium">Condition</th>
              <th scope="col" className="h-10 px-3 text-left font-medium">Action</th>
              <th scope="col" className="h-10 px-3 text-left font-medium">Owner</th>
              <th scope="col" className="h-10 px-3 text-left font-medium">State</th>
            </tr>
          </thead>
          <tbody>
            {rules.map((rule) => {
              const active = rule.id === selected?.id;
              return (
                <tr key={rule.id} tabIndex={0} aria-selected={active} onClick={() => setSelectedId(rule.id)} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setSelectedId(rule.id); } }} className={cn('h-12 cursor-pointer border-t border-[var(--border-default)] outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--focus-ring)]', active ? 'bg-[var(--surface-selected)] shadow-[inset_2px_0_0_var(--signal)]' : 'hover:bg-[var(--surface-subtle)]')}>
                  <td className="px-3 font-mono tabular-nums">{rule.priority}</td>
                  <td className="px-3 font-medium">{rule.title}</td>
                  <td className="px-3 font-mono text-[11.5px] text-[var(--text-2)]">{rule.condition}</td>
                  <td className="px-3">{rule.action}</td>
                  <td className="px-3 text-[var(--text-2)]">{rule.owner}</td>
                  <td className="px-3"><StatusLabel compact tone={rule.state === 'Active' ? 'verified' : 'neutral'}>{rule.state}</StatusLabel></td>
                </tr>
              );
            })}
            {rules.length === 0 ? (
              <tr><td colSpan={6} className="px-3 py-6 text-[13px] text-[var(--text-2)]">Loading controls…</td></tr>
            ) : null}
          </tbody>
        </table>

        <section id="simulator" aria-labelledby="simulator-title" className="grid gap-4 border-t border-[var(--border-default)] p-4 md:grid-cols-[1fr_1fr_1fr]">
          <div>
            <h2 id="simulator-title" className="font-mono text-[10.5px] uppercase tracking-[var(--tracking-label)] text-[var(--text-2)]">Evaluation preview</h2>
            <label className="mt-2 grid gap-1 text-[11px] font-medium text-[var(--text-2)]">
              Payment amount (USD)
              <input inputMode="decimal" value={testAmount} onChange={(event) => setTestAmount(event.target.value.replace(/[^\d.]/g, ''))} className="h-10 rounded-[var(--r-control)] border border-[var(--border-strong)] bg-[var(--surface-raised)] px-3 font-mono text-[14px] tabular-nums focus:border-[var(--signal)] focus:outline-none" />
            </label>
            <p className="mt-2 text-[11px] text-[var(--text-muted)]">Preview mirrors the server rules for a verified beneficiary on an enabled corridor. The server evaluates the real proposal.</p>
          </div>
          <div>
            <h3 className="font-mono text-[10.5px] uppercase tracking-[var(--tracking-label)] text-[var(--text-2)]">Results</h3>
            <ul className="mt-2 grid gap-1 text-[12.5px]">
              {simulation?.results.map(({ rule, outcome }) => (
                <li key={rule.id} className="flex items-center justify-between gap-2 border-b border-[var(--border-default)] py-1">
                  <span className="truncate">{rule.priority}. {rule.title}</span>
                  <StatusLabel compact tone={outcome === 'Failed' ? 'exception' : outcome === 'Approval required' ? 'attention' : 'verified'}>{outcome}</StatusLabel>
                </li>
              ))}
            </ul>
          </div>
          <div>
            <h3 className="font-mono text-[10.5px] uppercase tracking-[var(--tracking-label)] text-[var(--text-2)]">Outcome</h3>
            {simulation ? (
              <div className="mt-2 border border-[var(--border-default)] bg-[var(--surface-raised)] p-3">
                <StatusLabel tone={simulation.verdict === 'Blocked' ? 'exception' : simulation.verdict === 'Approval required' ? 'attention' : 'verified'}>{simulation.verdict}</StatusLabel>
                <p className="mt-2 text-[12.5px] text-[var(--text-2)]">{simulation.reason}</p>
              </div>
            ) : null}
          </div>
        </section>
      </Workspace>
    </>
  );
}
