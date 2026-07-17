'use client';

import { useEffect, useRef, useState } from 'react';
import { useReactToPrint } from 'react-to-print';
import { ExternalLink } from 'lucide-react';

import Receipt from '@/components/Receipt';
import SettlementProofDrawer from '@/components/SettlementProofDrawer';
import type { TransferState } from '@/app/dashboard/payments/new/page';

export default function StepReceipt({ state, reset }: { state: TransferState; reset: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [issuedAt, setIssuedAt] = useState('');
  const [reference, setReference] = useState('');

  useEffect(() => {
    // Initial values are set on mount to avoid SSR hydration mismatch.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setIssuedAt(new Date().toISOString());
    setReference(`SPL-${Date.now().toString(36).toUpperCase()}`);
  }, []);
  const print = useReactToPrint({ contentRef: ref, documentTitle: `splash-receipt-${state.txDigest?.slice(0, 8) ?? 'draft'}` });

  const digest = state.txDigest ?? null;
  const explorerUrl = digest ? `https://testnet.suivision.xyz/txblock/${digest}` : null;

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
        network="Sui Testnet"
        status={digest ? 'Settled' : 'Pending'}
        timestamp={issuedAt}
        reference={reference}
        explorerUrl={explorerUrl}
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
          <div className="text-xs font-black uppercase tracking-[0.15em] text-[#326273]/55">Composed actions in this digest</div>
          <div className="mt-3 grid gap-3 md:grid-cols-3">
            {state.composedActions.map((action) => (
              <div key={`${action.kind}-${action.eventType}`} className="rounded-xl bg-white p-3">
                <div className="text-sm font-extrabold text-[#326273]">{action.label}</div>
                <pre className="mt-2 max-h-28 overflow-auto whitespace-pre-wrap break-all text-[10px] text-[#326273]/55">{JSON.stringify(action.data, null, 2)}</pre>
              </div>
            ))}
          </div>
          <div className="mt-3 grid gap-2 text-[11px] text-[#326273]/60 md:grid-cols-3">
            <div className="break-all"><strong>Intent:</strong> {state.paymentIntentId}</div>
            <div className="break-all"><strong>Walrus:</strong> {state.walrusBlobId}</div>
            <div className="break-all"><strong>Anchor:</strong> {state.auditAnchorId}</div>
          </div>
        </section>
      ) : null}
      <div className="flex flex-wrap gap-3">
        <button onClick={() => print()} className="flex-1 min-w-[140px] rounded-lg bg-[#326273] py-3 font-bold text-white shadow-sm transition-colors hover:bg-[#264e5b]">Download PDF</button>
        {explorerUrl && (
          <a
            href={explorerUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="flex-1 min-w-[140px] inline-flex items-center justify-center gap-2 rounded-lg border border-[#5C9EAD] bg-white py-3 font-bold text-[#326273] hover:bg-[#5C9EAD]/10"
          >
            View on Sui Explorer
            <ExternalLink className="h-4 w-4" />
          </a>
        )}
        <button onClick={reset} className="flex-1 min-w-[140px] rounded-lg border border-[#326273]/20 py-3 font-semibold text-[#326273] hover:border-[#5C9EAD]">New transfer</button>
      </div>
    </div>
  );
}

function selectionLabel(selection: TransferState['funding']['selection']) {
  if (selection.type === 'held') return 'Splash balance';
  if (selection.type === 'fiat') return `Bank USD via ${selection.provider}`;
  return `${selection.asset} via ${selection.rail}${selection.sourceChain ? ` / ${selection.sourceChain}` : ''}`;
}
