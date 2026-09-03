'use client';

import { Download, Printer, Share2 } from 'lucide-react';
import Link from 'next/link';
import { use, useEffect, useState } from 'react';
import { toast } from 'sonner';

import ExplorerLinks from '@/components/dashboard/ExplorerLinks';
import { Badge, Button, Card, ProofDrawer, ProofRow, SettlementTimeline, Skeleton, Stat, toCsv } from '@/components/system';
import { ID_PAYOUT_RAILS, PH_PAYOUT_RAILS } from '@/content/money-path';
import { formatInstant } from '@/lib/format/time';
import { explorerTxUrl, receiptNetworkLine } from '@/lib/network';
import { STATE_LABELS } from '@/lib/settlement/delivery-states';
import { railForCurrency, timelineEntriesFrom } from '@/lib/settlement/map-transfer-state';
import type { AuditReceipt, TransferIntentRecord } from '@/lib/server/operations';

type AuditView = { transfer: TransferIntentRecord; receipt: AuditReceipt | null };

const money = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function partnerFor(currency: string) {
  const rails = currency === 'IDR' ? ID_PAYOUT_RAILS : PH_PAYOUT_RAILS;
  return rails.find((rail) => rail.active) ?? rails[0];
}

/**
 * Receipt detail for the transaction parties. Shows the D7 timeline, the
 * settlement digest, delivery evidence, and — because the operator is a
 * party — the payout partner's legal name once a contract is signed, with
 * the statement-descriptor explainer.
 */
export default function ReceiptDetailPage({ params }: { params: Promise<{ id: string }> }) {
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
      <Card>
        <p className="text-[14px]">This receipt is not available for your workspace.</p>
        <Button href="/dashboard/receipts" variant="ghost" size="sm" className="mt-3">
          Back to receipts
        </Button>
      </Card>
    );
  }

  const transfer = view?.transfer;
  const history = view?.receipt?.statusHistory ?? [];
  const digest = transfer?.suiTxDigest && !transfer.suiTxDigest.startsWith('SIM_') ? transfer.suiTxDigest : null;
  const rail = transfer ? railForCurrency(transfer.targetCurrency) : 'sui-native';
  const entries = transfer ? timelineEntriesFrom(history, { digest, explorerUrl: digest ? explorerTxUrl(digest) : null, partnerRef: transfer.verificationReference }) : [];
  const partner = transfer ? partnerFor(transfer.targetCurrency) : null;
  const settled = transfer ? ['SETTLED', 'DISBURSED', 'CREDITED'].includes(transfer.state) : false;

  function exportCsv() {
    if (!transfer) return;
    const rows = entries.map((entry, index) => ({ id: String(index), state: STATE_LABELS[entry.state], at: entry.at ?? '', evidence: entry.evidence ? `${entry.evidence.label}: ${entry.evidence.value}` : '' }));
    const csv = toCsv(
      [
        { key: 'state', header: 'Hop' },
        { key: 'at', header: 'At (UTC)' },
        { key: 'evidence', header: 'Evidence' },
      ],
      rows,
    );
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `receipt-${transfer.id}.csv`;
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
    <div className="grid gap-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Link href="/dashboard/receipts" className="text-[13px] font-medium text-[var(--teal-600)] underline underline-offset-4">
            Receipts
          </Link>
          <h1 className="mt-1 text-[var(--text-h1)] font-semibold leading-[1.1] tracking-[-0.02em]">
            {transfer ? `${money.format(Number.parseFloat(transfer.sourceAmountUsd))} USD to ${transfer.recipientName}` : <Skeleton variant="money" />}
          </h1>
          <p className="mt-1 font-mono text-[12px] text-[var(--text-muted)]">
            {transfer?.id} · {receiptNetworkLine()}
          </p>
        </div>
        <div className="flex flex-wrap gap-2 print:hidden">
          <Button variant="ghost" size="sm" onClick={exportCsv} disabled={!transfer}>
            <Download aria-hidden="true" /> CSV
          </Button>
          <Button variant="ghost" size="sm" onClick={() => window.print()} disabled={!transfer}>
            <Printer aria-hidden="true" /> PDF
          </Button>
          <Button size="sm" onClick={share} disabled={!transfer}>
            <Share2 aria-hidden="true" /> Share
          </Button>
        </div>
      </header>

      <section className="grid gap-4 md:grid-cols-3">
        <Card>
          <Stat label="Sent" value={transfer ? money.format(Number.parseFloat(transfer.sourceAmountUsd)) : null} currency="USD" loading={!transfer} />
        </Card>
        <Card>
          <Stat label="Delivered" value={transfer ? transfer.targetAmount : null} currency={transfer?.targetCurrency} loading={!transfer} sub={transfer?.exchangeRate ? `Rate 1 USD = ${transfer.exchangeRate} ${transfer.targetCurrency} · illustrative` : undefined} />
        </Card>
        <Card tone={settled ? 'dark' : 'tint'}>
          <div className={settled ? 'text-white' : ''}>
            <div className="text-[13px] font-medium opacity-80">State</div>
            <div className="mt-1 text-[20px] font-semibold">{transfer ? <Badge tone={settled ? 'green' : transfer.state === 'FAILED' || transfer.state === 'REFUNDED' ? 'red' : 'amber'}>{settled ? 'Settled on Sui' : transfer.state === 'FAILED' || transfer.state === 'REFUNDED' ? 'Returned' : 'In progress'}</Badge> : <Skeleton variant="money" />}</div>
            {digest ? <div className="mt-3"><ExplorerLinks digest={digest} /></div> : null}
          </div>
        </Card>
      </section>

      <Card>
        <h2 className="mb-4 text-[15px] font-semibold">Settlement timeline</h2>
        {transfer ? <SettlementTimeline rail={rail} entries={entries} /> : <Skeleton variant="text" lines={5} />}
      </Card>

      <Card>
        <h2 className="mb-3 text-[15px] font-semibold">Delivery</h2>
        <dl className="grid gap-1">
          <ProofRow label="Payout partner" value={partner?.legalName ? partner.legalName : `${partner?.name ?? 'Licensed payout partner'} · legal name appears here once the partner contract is signed`} />
          <ProofRow label="Delivery leg" value={rail === 'sui-native' ? 'Sui-native to partner' : rail === 'cctp' ? 'CCTP hop to destination chain' : 'Bank wire to partner'} />
          <ProofRow label="Funding" value={transfer?.fundingMethod === 'HELD_BALANCE' ? 'Splash balance' : 'Bank USD'} />
          <ProofRow label="Reference" value={transfer?.verificationReference ?? 'Pending'} mono />
        </dl>
        <details className="mt-3 rounded-[var(--r-sm)] bg-[var(--surface-2)] px-3 py-2 text-[13px] text-[var(--text-2)]">
          <summary className="cursor-pointer font-medium text-[var(--text)]">Why does the bank statement show the partner&apos;s name?</summary>
          <p className="mt-2">
            {`The local bank transfer is issued by the licensed payout partner on its own licence, so the supplier's statement carries the partner's legal name as the sender and your reference in the description. Splash never holds the funds. `}
            <Link href="/help/statement-descriptor" className="text-[var(--teal-600)] underline underline-offset-2">
              Read the full explainer
            </Link>
            .
          </p>
        </details>
      </Card>

      <ProofDrawer>
        <dl>
          <ProofRow label="Sui digest" value={digest ?? 'Pending'} mono href={digest ? explorerTxUrl(digest) : undefined} />
          <ProofRow label="Payment intent" value={transfer?.paymentIntentId ?? 'Pending'} mono />
          <ProofRow label="Audit anchor" value={transfer?.auditAnchorId ?? 'Pending'} mono />
          <ProofRow label="Evidence blob" value={transfer?.walrusBlobId ?? view?.receipt?.walrusBlobId ?? 'Pending'} mono />
          <ProofRow label="Content hash" value={transfer?.auditHash ?? 'Pending'} mono />
          <ProofRow label="Issued" value={transfer ? formatInstant(transfer.createdAt) : '—'} />
        </dl>
        <p className="mt-3 text-[12px] text-[var(--text-muted)]">The public evidence blob carries the digest, content hashes and amounts. Counterparty and partner detail is not in the public blob.</p>
      </ProofDrawer>
    </div>
  );
}
