'use client';

import { FileText, Link2, Loader2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useReactToPrint } from 'react-to-print';
import { toast } from 'sonner';

import Receipt from '@/components/Receipt';
import SettlementProofDrawer from '@/components/SettlementProofDrawer';
import { Button } from '@/components/system';
import { explorerTxUrl, receiptNetworkLine } from '@/lib/network';
import { fundingLabel, type TransferState } from '@/lib/send/state';

/** The receipt the accountant prints and the supplier opens. */
export default function ReceiptStep({ state, reset }: { state: TransferState; reset: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [issuedAt, setIssuedAt] = useState('');
  const [reference, setReference] = useState('');
  const [operatorName, setOperatorName] = useState<string | null>(null);
  const [sharing, setSharing] = useState(false);

  useEffect(() => {
    // Set on mount to avoid an SSR hydration mismatch.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setIssuedAt(new Date().toISOString());
    setReference(`SPL-${Date.now().toString(36).toUpperCase()}`);
  }, []);

  useEffect(() => {
    let active = true;
    fetch('/api/auth/session')
      .then((response) => (response.ok ? response.json() : null))
      .then((body: { name?: string; organization?: string } | null) => {
        if (active && body?.name) setOperatorName(body.organization ? `${body.name} · ${body.organization}` : body.name);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);

  const print = useReactToPrint({
    contentRef: ref,
    documentTitle: `splash-receipt-${state.txDigest?.slice(0, 8) ?? 'draft'}`,
    pageStyle: '@page { size: A4; margin: 14mm } body { background: #FFFFFF }',
  });

  const digest = state.txDigest ?? null;

  async function shareWithSupplier() {
    if (!state.transferIntentId) {
      toast.error('The share link is available once the payment is authorised.');
      return;
    }
    setSharing(true);
    try {
      const response = await fetch('/api/receipts/share', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transferIntentId: state.transferIntentId, fee: state.quote?.fee, reference, issuedAt }),
      });
      const body = (await response.json().catch(() => null)) as { url?: string; error?: string } | null;
      if (!response.ok || !body?.url) throw new Error(body?.error ?? "Couldn't create the share link. Retry.");
      const url = `${window.location.origin}${body.url}`;
      if (navigator.share) await navigator.share({ title: 'Payment receipt', url });
      else {
        await navigator.clipboard.writeText(url);
        toast.success('Read-only receipt link copied', { description: 'Your supplier can open it without a login.' });
      }
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "Couldn't create the share link. Retry.");
    } finally {
      setSharing(false);
    }
  }

  return (
    <div className="grid gap-5">
      <Receipt
        ref={ref}
        txDigest={digest ?? state.receiptObjectId ?? 'Pending'}
        sender="Splash operator"
        recipient={state.recipient.bank?.account ?? state.recipient.name}
        recipientName={state.recipient.name}
        amount={state.amount.value}
        currency="USD"
        fee={state.quote?.fee ?? '0.00'}
        feeTier={state.funding.selection.feeTier}
        fundingSource={fundingLabel(state.funding.selection)}
        status={digest ? 'Settled' : 'Pending'}
        timestamp={issuedAt}
        reference={reference}
        explorerUrl={digest ? explorerTxUrl(digest) : null}
        amountToPayee={state.quote?.netReceived ? `${state.quote.netReceived} ${state.amount.targetCurrency}` : undefined}
        fxRate={state.quote?.fxRate}
        targetCurrency={state.amount.targetCurrency}
        invoiceRef={state.invoiceId}
        invoiceClosedOnDelivery={Boolean(state.invoiceId && digest)}
        approvedBy={operatorName ?? undefined}
        sentAt={issuedAt}
        deliveredAt={digest ? issuedAt : undefined}
        walrusBlobId={state.walrusBlobId}
        sealedState={state.walrusBlobId ? 'Sealed · access-controlled' : undefined}
        networkLine={receiptNetworkLine()}
      />
      <SettlementProofDrawer transferIntentId={state.transferIntentId} fallback={{ digest, walrusBlobId: state.walrusBlobId, auditAnchorId: state.auditAnchorId }} />
      <div className="grid gap-2 sm:grid-cols-3 print:hidden">
        <Button onClick={() => print()} fullWidth>
          <FileText aria-hidden="true" /> PDF for your accountant
        </Button>
        <Button variant="ghost" onClick={() => void shareWithSupplier()} disabled={sharing} fullWidth>
          {sharing ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Link2 aria-hidden="true" />} Share with supplier
        </Button>
        <Button variant="ghost" onClick={reset} fullWidth>
          New payment
        </Button>
      </div>
      {state.transferIntentId ? (
        <Button variant="ghost" size="sm" href={`/dashboard/receipts/${state.transferIntentId}`} className="justify-self-start print:hidden">
          Open the full settlement timeline
        </Button>
      ) : null}
    </div>
  );
}
