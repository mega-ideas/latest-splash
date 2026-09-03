'use client';

import { Download, Printer, Share2 } from 'lucide-react';
import Link from 'next/link';
import { use, useEffect, useState } from 'react';
import { toast } from 'sonner';

import ExplorerLinks from '@/components/dashboard/ExplorerLinks';
import ClearanceProgress from '@/components/shell/ClearanceProgress';
import EvidenceList from '@/components/shell/EvidenceList';
import { InspectorField } from '@/components/shell/Inspector';
import { PageHeader } from '@/components/shell/PageHeader';
import StatusLabel from '@/components/shell/StatusLabel';
import { Button, ProofDrawer, ProofRow, SettlementTimeline, Skeleton } from '@/components/system';
import { ID_PAYOUT_RAILS, PH_PAYOUT_RAILS } from '@/content/money-path';
import { formatInstant } from '@/lib/format/time';
import { formatMoney, formatRate } from '@/lib/money';
import { explorerTxUrl, receiptNetworkLine } from '@/lib/network';
import { fromTransfer } from '@/lib/payments/clearance';
import { STATE_LABELS } from '@/lib/settlement/delivery-states';
import { railForCurrency, timelineEntriesFrom } from '@/lib/settlement/map-transfer-state';
import type { AuditReceipt, TransferIntentRecord } from '@/lib/server/operations';

type AuditView = { transfer: TransferIntentRecord; receipt: AuditReceipt | null };

function partnerFor(currency: string) {
  const rails = currency === 'IDR' ? ID_PAYOUT_RAILS : PH_PAYOUT_RAILS;
  return rails.find((rail) => rail.active) ?? rails[0];
}

/**
 * The clearance record, full page: the same record the board and the
 * payments register show in their inspector, here as the mobile route and
 * the printable receipt for the transaction parties. Decision → money →
 * route → evidence → proof, then the D7 settlement timeline.
 */
export default function ClearanceRecordPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [view, setView] = useState<AuditView | null>(null);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    let active = true;
    fetch(`/api/audit/${id}`, { cache: 'no-store' })
      .then(async (response) => {
        if (!response.ok) throw new Error('missing');
        return (await response.json()) as AuditView;
      })
      .then((body) => {
        if (active) setView(body);
      })
      .catch(() => {
        if (active) setMissing(true);
      });
    return () => {
      active = false;
    };
  }, [id]);

  if (missing) {
    return (
      <div className="border border-[var(--border-default)] bg-[var(--surface-raised)] p-6">
        <p className="text-[14px]">This clearance record is not available for your workspace.</p>
        <Button href="/dashboard/payments" variant="secondary" size="sm" className="mt-3">
          Back to payments
        </Button>
      </div>
    );
  }

  const transfer = view?.transfer ?? null;
  const record = transfer ? fromTransfer(transfer) : null;
  const digest = transfer?.suiTxDigest ?? null;
  const rail = transfer ? railForCurrency(transfer.targetCurrency) : 'sui-native';
  const entries = transfer ? timelineEntriesFrom(view?.receipt?.statusHistory ?? [{ state: transfer.state, at: transfer.updatedAt }], { digest, explorerUrl: digest ? explorerTxUrl(digest) : null, partnerRef: transfer.verificationReference }) : [];
  const partner = transfer ? partnerFor(transfer.targetCurrency) : null;

  function exportCsv() {
    if (!transfer || !record) return;
    const rows = [
      ['Record', transfer.id],
      ['Beneficiary', transfer.recipientName],
      ['Send', formatMoney('USD', transfer.sourceAmountUsd)],
      ['Receive', formatMoney(transfer.targetCurrency, transfer.targetAmount)],
      ['Effective FX', transfer.exchangeRate ? formatRate('USD', transfer.targetCurrency, transfer.exchangeRate) : ''],
      ['State', record.status],
      ['Sui digest', digest ?? ''],
      ['Audit anchor', transfer.auditAnchorId ?? ''],
      ['Evidence blob', transfer.walrusBlobId ?? view?.receipt?.walrusBlobId ?? ''],
      ['Issued', transfer.createdAt],
      ...entries.map((entry) => [STATE_LABELS[entry.state], entry.at ?? '']),
    ];
    const csv = rows.map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `clearance-${transfer.id}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  async function share() {
    if (!transfer) return;
    try {
      const response = await fetch('/api/receipts/share', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transferIntentId: transfer.id, fee: transfer.fundingFeeTier === 'DISCOUNT' ? '0.00' : undefined }),
      });
      const body = (await response.json()) as { url?: string; error?: string };
      if (!response.ok || !body.url) throw new Error(body.error ?? 'Share link unavailable');
      const url = new URL(body.url, window.location.origin).toString();
      if (navigator.share) {
        await navigator.share({ title: 'Payment receipt', url });
      } else {
        await navigator.clipboard.writeText(url);
        toast.success('Receipt link copied');
      }
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : 'Could not share');
    }
  }

  return (
    <>
      <div className="mb-2 font-mono text-[11px] text-[var(--text-muted)]">
        <Link href="/dashboard/payments" className="text-[var(--signal)] underline-offset-4 hover:underline">Payments</Link> / Clearance record
      </div>
      <PageHeader
        title={transfer ? `${transfer.id.slice(0, 18)} · ${transfer.recipientName}` : 'Clearance record'}
        supporting={transfer ? `${record?.purpose} · ${receiptNetworkLine()}` : undefined}
        actions={
          <>
            <Button variant="secondary" size="sm" onClick={exportCsv} disabled={!transfer}>
              <Download aria-hidden="true" /> Evidence bundle
            </Button>
            <Button variant="secondary" size="sm" onClick={() => window.print()} disabled={!transfer}>
              <Printer aria-hidden="true" /> Print
            </Button>
            <Button size="sm" onClick={share} disabled={!transfer}>
              <Share2 aria-hidden="true" /> Share with beneficiary
            </Button>
          </>
        }
      />

      {record ? (
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <StatusLabel>{record.status}</StatusLabel>
          {digest ? <ExplorerLinks digest={digest} /> : null}
        </div>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(22.5rem,25rem)]">
        <div className="grid content-start gap-4">
          <section aria-labelledby="money" className="border border-[var(--border-default)] bg-[var(--surface-raised)] p-4">
            <h2 id="money" className="font-mono text-[10.5px] uppercase tracking-[var(--tracking-label)] text-[var(--text-2)]">Money</h2>
            {transfer ? (
              <div className="mt-3 grid grid-cols-2 gap-3 md:grid-cols-4">
                <InspectorField label="Send amount" mono>{formatMoney('USD', transfer.sourceAmountUsd)}</InspectorField>
                <InspectorField label="Receive amount" mono>{formatMoney(transfer.targetCurrency, transfer.targetAmount)}</InspectorField>
                <InspectorField label="Effective FX" mono>{transfer.exchangeRate ? formatRate('USD', transfer.targetCurrency, transfer.exchangeRate) : '—'}</InspectorField>
                <InspectorField label="Issued" mono>{formatInstant(transfer.createdAt)}</InspectorField>
              </div>
            ) : (
              <Skeleton variant="text" lines={2} />
            )}
          </section>

          <section aria-labelledby="checkpoints" className="border border-[var(--border-default)] bg-[var(--surface-raised)] p-4">
            <h2 id="checkpoints" className="font-mono text-[10.5px] uppercase tracking-[var(--tracking-label)] text-[var(--text-2)]">Checkpoints</h2>
            <div className="mt-3">{record ? <ClearanceProgress states={record.checkpoints} /> : <Skeleton variant="text" lines={1} />}</div>
          </section>

          <section aria-labelledby="timeline" className="border border-[var(--border-default)] bg-[var(--surface-raised)] p-4">
            <h2 id="timeline" className="font-mono text-[10.5px] uppercase tracking-[var(--tracking-label)] text-[var(--text-2)]">Settlement timeline</h2>
            <div className="mt-3">{transfer ? <SettlementTimeline rail={rail} entries={entries} /> : <Skeleton variant="text" lines={5} />}</div>
          </section>

          <section aria-labelledby="delivery" className="border border-[var(--border-default)] bg-[var(--surface-raised)] p-4">
            <h2 id="delivery" className="font-mono text-[10.5px] uppercase tracking-[var(--tracking-label)] text-[var(--text-2)]">Route and delivery</h2>
            <dl className="mt-2">
              <ProofRow label="Payout partner" value={partner?.legalName ? partner.legalName : `${partner?.name ?? 'Licensed payout partner'} · legal name appears here once the partner contract is signed`} />
              <ProofRow label="Delivery leg" value={rail === 'sui-native' ? 'Sui-native to partner' : rail === 'cctp' ? 'CCTP hop to destination chain' : 'Bank wire to partner'} />
              <ProofRow label="Funding" value={transfer?.fundingMethod === 'HELD_BALANCE' ? 'Held balance' : 'Bank USD'} />
              <ProofRow label="Reference" value={transfer?.verificationReference ?? 'Pending'} mono />
            </dl>
            <details className="mt-3 border border-[var(--border-default)] bg-[var(--surface-subtle)] px-3 py-2 text-[13px] text-[var(--text-2)]">
              <summary className="cursor-pointer font-medium text-[var(--text)]">Why does the bank statement show the partner&apos;s name?</summary>
              <p className="mt-2">
                The local bank transfer is issued by the licensed payout partner on its own licence, so the beneficiary&apos;s statement carries the partner&apos;s legal name as the sender and your reference in the description. {`${'Splash'} never holds the funds. `}
                <Link href="/help/statement-descriptor" className="text-[var(--signal)] underline underline-offset-2">Read the full explainer</Link>.
              </p>
            </details>
          </section>
        </div>

        <aside className="grid content-start gap-4" aria-label="Evidence">
          <section className="border border-[var(--border-default)] bg-[var(--surface-subtle)] p-4">
            <h2 className="font-mono text-[10.5px] uppercase tracking-[var(--tracking-label)] text-[var(--text-2)]">Evidence timeline</h2>
            <div className="mt-2">{record ? <EvidenceList items={record.evidence} /> : <Skeleton variant="text" lines={6} />}</div>
          </section>
          <ProofDrawer>
            <dl>
              <ProofRow label="Sui digest" value={digest ?? 'Pending'} mono href={digest ? explorerTxUrl(digest) : undefined} />
              <ProofRow label="Payment intent" value={transfer?.paymentIntentId ?? 'Pending'} mono />
              <ProofRow label="Audit anchor" value={transfer?.auditAnchorId ?? 'Pending'} mono />
              <ProofRow label="Evidence blob" value={transfer?.walrusBlobId ?? view?.receipt?.walrusBlobId ?? 'Pending'} mono />
              <ProofRow label="Content hash" value={transfer?.auditHash ?? 'Pending'} mono />
            </dl>
            <p className="mt-3 text-[12px] text-[var(--text-muted)]">The public evidence blob carries the digest, content hashes and amounts. Counterparty and partner detail is not in the public blob.</p>
          </ProofDrawer>
        </aside>
      </div>
    </>
  );
}
