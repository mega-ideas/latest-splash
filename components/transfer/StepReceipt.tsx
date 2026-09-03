'use client';

import { useEffect, useRef, useState } from 'react';
import { useReactToPrint } from 'react-to-print';
import { FileText, Link2, Loader2 } from 'lucide-react';
import { toast } from 'sonner';

import Receipt from '@/components/Receipt';
import SettlementProofDrawer from '@/components/SettlementProofDrawer';
import { receiptNetworkLine } from '@/lib/network-label';
import type { TransferState } from '@/app/dashboard/transfer/page';

export default function StepReceipt({ state, reset }: { state: TransferState; reset: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [issuedAt, setIssuedAt] = useState('');
  const [reference, setReference] = useState('');
  const [operatorName, setOperatorName] = useState<string | null>(null);
  const [sharing, setSharing] = useState(false);

  useEffect(() => {
    // Initial values are set on mount to avoid SSR hydration mismatch.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setIssuedAt(new Date().toISOString());
    setReference(`SPL-${Date.now().toString(36).toUpperCase()}`);
  }, []);

  // "Approved by" renders the signed-in operator (maker-checker note beside it).
  useEffect(() => {
    let active = true;
    void fetch('/api/auth/session')
      .then((response) => (response.ok ? response.json() : null))
      .then((body: { name?: string; organization?: string } | null) => {
        if (active && body?.name) setOperatorName(body.organization ? `${body.name} · ${body.organization}` : body.name);
      })
      .catch(() => {});
    return () => { active = false; };
  }, []);

  const print = useReactToPrint({
    contentRef: ref,
    documentTitle: `splash-receipt-${state.txDigest?.slice(0, 8) ?? 'draft'}`,
    // Clean A4 for the accountant: the business face fills the sheet; the
    // proof layer stays collapsed (verification is an online act).
    pageStyle: '@page { size: A4; margin: 14mm } body { background: #FFFFFF }',
  });

  const digest = state.txDigest ?? null;
  const explorerUrl = digest ? `https://testnet.suivision.xyz/txblock/${digest}` : null;

  async function shareWithSupplier() {
    if (!state.transferIntentId) {
      toast.error('The share link is available once the payment is authorized.');
      return;
    }
    setSharing(true);
    try {
      const response = await fetch('/api/receipts/share', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          transferIntentId: state.transferIntentId,
          fee: state.quote?.fee,
          reference,
          issuedAt,
        }),
      });
      const body = (await response.json().catch(() => null)) as { url?: string; error?: string } | null;
      if (!response.ok || !body?.url) throw new Error(body?.error ?? "Couldn't create the share link. Retry.");
      const url = `${window.location.origin}${body.url}`;
      await navigator.clipboard.writeText(url);
      toast.success('Read-only receipt link copied', { description: 'Your supplier can open it without a login.' });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Couldn't create the share link. Retry.");
    } finally {
      setSharing(false);
    }
  }

  return (
    <div className="space-y-5">
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
        fundingSource={selectionLabel(state.funding.selection)}
        status={digest ? 'Settled' : 'Pending'}
        timestamp={issuedAt}
        reference={reference}
        explorerUrl={explorerUrl}
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
      <SettlementProofDrawer
        transferIntentId={state.transferIntentId}
        fallback={{
          digest,
          walrusBlobId: state.walrusBlobId,
          auditAnchorId: state.auditAnchorId,
        }}
      />
      {state.composedActions?.length ? (
        <section className="rounded-2xl border border-[#5C9EAD]/30 bg-[#5C9EAD]/10 p-5">
          <div className="text-xs font-semibold uppercase tracking-[0.15em] text-[#326273]/55">Composed actions in this digest</div>
          <div className="mt-3 grid gap-3 md:grid-cols-3">
            {state.composedActions.map((action) => (
              <div key={`${action.kind}-${action.eventType}`} className="rounded-xl bg-white p-3">
                <div className="text-sm font-semibold text-[#326273]">{action.label}</div>
                <pre className="mt-2 max-h-28 overflow-auto whitespace-pre-wrap break-all text-[13px] text-[#326273]/55">{JSON.stringify(action.data, null, 2)}</pre>
              </div>
            ))}
          </div>
          <div className="mt-3 grid gap-2 text-[13px] text-[#326273]/60 md:grid-cols-3">
            <div className="break-all"><strong>Intent:</strong> {state.paymentIntentId}</div>
            <div className="break-all"><strong>Walrus:</strong> {state.walrusBlobId}</div>
            <div className="break-all"><strong>Anchor:</strong> {state.auditAnchorId}</div>
          </div>
        </section>
      ) : null}
      <div className="flex flex-wrap gap-3">
        <button onClick={() => print()} className="flex-1 min-w-[170px] inline-flex items-center justify-center gap-2 rounded-lg bg-[#326273] py-3 font-semibold text-white shadow-sm transition-colors hover:bg-[#264e5b]">
          <FileText className="h-4 w-4" aria-hidden="true" />
          PDF for your accountant
        </button>
        <button
          onClick={() => void shareWithSupplier()}
          disabled={sharing}
          className="flex-1 min-w-[170px] inline-flex items-center justify-center gap-2 rounded-lg border border-[#5C9EAD] bg-white py-3 font-semibold text-[#326273] transition-colors hover:bg-[#5C9EAD]/10 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {sharing ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Link2 className="h-4 w-4" aria-hidden="true" />}
          Share with supplier
        </button>
        <button onClick={reset} className="flex-1 min-w-[140px] rounded-lg border border-[#326273]/20 py-3 font-medium text-[#326273] hover:border-[#5C9EAD]">New transfer</button>
      </div>
    </div>
  );
}

function selectionLabel(selection: TransferState['funding']['selection']) {
  if (selection.type === 'held') return 'Splash balance';
  if (selection.type === 'fiat') return `Bank USD via ${selection.provider}`;
  return `${selection.asset} via ${selection.rail}${selection.sourceChain ? ` / ${selection.sourceChain}` : ''}`;
}
