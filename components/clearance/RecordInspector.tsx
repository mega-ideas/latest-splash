'use client';

import { Download } from 'lucide-react';

import ClearanceProgress from '@/components/shell/ClearanceProgress';
import EvidenceList from '@/components/shell/EvidenceList';
import Inspector, { InspectorField, InspectorSection } from '@/components/shell/Inspector';
import StatusLabel from '@/components/shell/StatusLabel';
import { Button } from '@/components/system';
import { formatAmount, formatMoney, formatRate } from '@/lib/money';
import { routeAlternatives, shortTime, type ClearanceRecord } from '@/lib/payments/clearance';
import { cn } from '@/lib/utils';

/**
 * The clearance record, wherever a row is selected: decision → money →
 * route → evidence → identifiers → action. Approval never happens here;
 * the primary action hands the same record id to the Approvals surface.
 */
export default function RecordInspector({ record, onClose }: { record: ClearanceRecord; onClose: () => void }) {
  const alternatives = routeAlternatives(record.corridor.to, Number.parseFloat(record.send.amount) || 0);
  return (
    <Inspector
      title={`${record.id.slice(0, 18)} · ${record.beneficiary}`}
      subtitle={<StatusLabel compact>{record.status}</StatusLabel>}
      onClose={onClose}
      actions={
        record.kind === 'proposal' ? (
          <>
            <Button href={record.href}>Review in Approvals</Button>
            <Button href="/dashboard/oxwal" variant="secondary">
              Return to maker
            </Button>
          </>
        ) : (
          <>
            <Button href={record.href}>Open clearance record</Button>
            <Button href={record.href} variant="secondary">
              <Download aria-hidden="true" /> Evidence bundle
            </Button>
          </>
        )
      }
    >
      <InspectorSection title="Decision">
        <div className="grid gap-2">
          <InspectorField label="Payment purpose">{record.purpose}</InspectorField>
          {record.kind === 'proposal' ? (
            <p className="border border-[var(--border-default)] bg-[var(--surface-raised)] px-3 py-2 text-[12.5px] text-[var(--text-2)]">
              Creation does not move funds. Checker approval is required. {record.approvalsCollected ?? 0} of {record.requiredApprovers ?? 1} approvals recorded.
            </p>
          ) : record.failureReason ? (
            <p className="border border-[var(--state-exception)] bg-[var(--surface-exception)] px-3 py-2 text-[12.5px] text-[var(--state-exception)]">{record.failureReason}</p>
          ) : null}
        </div>
      </InspectorSection>

      <InspectorSection title="Money">
        <div className="grid grid-cols-2 gap-3 border-y border-[var(--border-default)] py-3">
          <InspectorField label="Send amount" mono>{record.send.amount === '—' ? '—' : formatMoney(record.send.currency, record.send.amount)}</InspectorField>
          <InspectorField label="Receive amount" mono>{record.receive.amount === '—' ? '—' : formatMoney(record.receive.currency, record.receive.amount)}</InspectorField>
          <InspectorField label="Effective FX" mono>{record.rate ? formatRate('USD', record.corridor.to, record.rate) : '—'}</InspectorField>
          <InspectorField label="Valuation time" mono>{shortTime(record.updatedAt) ?? '—'}</InspectorField>
        </div>
      </InspectorSection>

      <InspectorSection title="Route comparison" aside={<span className="font-mono text-[10px] text-[var(--text-muted)]">illustrative baselines</span>}>
        <table className="w-full text-[11.5px]">
          <thead>
            <tr className="font-mono text-[9.5px] uppercase tracking-[var(--tracking-label)] text-[var(--text-muted)]">
              <th scope="col" className="py-1 text-left font-medium">Route</th>
              <th scope="col" className="py-1 text-right font-medium">All-in fee</th>
              <th scope="col" className="py-1 text-right font-medium">Delivered</th>
              <th scope="col" className="py-1 text-right font-medium">ETA</th>
            </tr>
          </thead>
          <tbody>
            {alternatives.rows.map((row) => (
              <tr key={row.id} className={cn('border-t border-[var(--border-default)]', row.recommended && 'bg-[var(--surface-selected)] shadow-[inset_2px_0_0_var(--signal)]')}>
                <td className="py-1.5 pl-2">
                  <span className="block font-medium">{row.route}</span>
                  {row.recommended ? <span className="text-[10px] text-[var(--signal)]">Recommended · lowest all-in cost, highest delivered amount</span> : null}
                </td>
                <td className="py-1.5 text-right font-mono tabular-nums">
                  USD {row.feeUsd.toFixed(2)}
                  <span className="block text-[10px] text-[var(--text-muted)]">({row.feePct.toFixed(2)}%)</span>
                </td>
                <td className="py-1.5 text-right font-mono tabular-nums">{alternatives.currency} {formatAmount(alternatives.currency, row.delivered)}</td>
                <td className="py-1.5 pr-1 text-right font-mono">
                  {row.eta}
                  <span className="block text-[10px] text-[var(--text-muted)]">{row.freshness}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-2 text-[10.5px] text-[var(--text-muted)]">Partner rail from the live quote; wire and MTO rows are reviewed category baselines, not named providers. On-chain settlement ~400ms; delivery per local rail.</p>
      </InspectorSection>

      <InspectorSection title="Checkpoints">
        <ClearanceProgress states={record.checkpoints} />
      </InspectorSection>

      <InspectorSection title="Evidence timeline">
        <EvidenceList items={record.evidence} />
      </InspectorSection>

      <InspectorSection title="Identifiers">
        <div className="grid gap-2">
          <InspectorField label="Record" mono>{record.id}</InspectorField>
          {record.digest ? <InspectorField label="Sui digest" mono>{record.digest}</InspectorField> : null}
          {record.blobId ? <InspectorField label="Walrus blob" mono>{record.blobId}</InspectorField> : null}
        </div>
      </InspectorSection>
    </Inspector>
  );
}
