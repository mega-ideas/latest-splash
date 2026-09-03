import { notFound } from 'next/navigation';
import Image from 'next/image';
import Link from 'next/link';

import Receipt from '@/components/Receipt';
import { receiptNetworkLine } from '@/lib/network-label';
import { findReceiptShare } from '@/lib/server/receipt-share';

export const dynamic = 'force-dynamic';

/**
 * W9.2 — public, read-only receipt (the "Share with supplier" link).
 *
 * Reuses the app/pay/[slug] pattern: an unguessable token resolves one
 * record and the page renders the SAME Receipt component the operator sees,
 * without login. Anything the token does not name stays invisible.
 */
export default async function SharedReceiptPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const share = findReceiptShare(token);
  if (!share) notFound();

  const { intent, audit, display } = share;
  const settled = Boolean(intent.suiTxDigest);
  const explorerUrl = intent.suiTxDigest ? `https://testnet.suivision.xyz/txblock/${intent.suiTxDigest}` : null;
  const history = audit?.statusHistory ?? [];
  const sentAt = history[0]?.at ?? intent.createdAt;
  const deliveredAt =
    history.find((entry) => entry.state === 'DISBURSED' || entry.state === 'CREDITED' || entry.state === 'SETTLED')?.at
    ?? (settled ? intent.updatedAt : undefined);

  return (
    <main className="min-h-screen bg-[#F6F0ED] px-4 py-10">
      <div className="mx-auto max-w-xl space-y-5">
        <header className="flex items-center justify-between gap-3">
          <Link href="/" className="inline-flex items-center gap-2 text-[#1F4452]">
            <Image src="/splash-main-icon.png" alt="Splash" width={32} height={31} className="h-8 w-8 object-contain" />
            <strong className="text-lg font-semibold">Splash<span className="text-[#5C9EAD]">.</span></strong>
          </Link>
          <span className="text-[13px] font-medium text-[#326273]/60">Read-only receipt</span>
        </header>

        <Receipt
          txDigest={intent.suiTxDigest ?? intent.receiptObjectId ?? 'Pending'}
          sender="Splash operator"
          recipient={intent.recipientName}
          recipientName={intent.recipientName}
          amount={intent.sourceAmountUsd}
          currency="USD"
          fee={display.fee ?? '—'}
          fundingSource={intent.fundingMethod === 'BANK_USD' ? 'Bank USD' : intent.fundingMethod === 'HELD_BALANCE' ? 'Splash balance' : undefined}
          status={settled ? 'Settled' : 'Pending'}
          timestamp={display.issuedAt ?? intent.createdAt}
          reference={display.reference ?? intent.verificationReference ?? undefined}
          explorerUrl={explorerUrl}
          amountToPayee={`${intent.targetAmount} ${intent.targetCurrency}`}
          fxRate={intent.exchangeRate ?? undefined}
          targetCurrency={intent.targetCurrency}
          invoiceRef={intent.invoiceId}
          invoiceClosedOnDelivery={Boolean(intent.invoiceId && settled)}
          approvedBy={display.approvedBy ?? audit?.approvedBy ?? undefined}
          sentAt={sentAt}
          deliveredAt={deliveredAt}
          walrusBlobId={intent.walrusBlobId ?? audit?.walrusBlobId}
          sealedState={intent.walrusBlobId || audit?.walrusBlobId ? 'Sealed · access-controlled' : undefined}
          networkLine={receiptNetworkLine()}
        />

        <p className="text-center text-[13px] font-medium text-[#326273]/55">
          Shared by the payer. This link shows this receipt only.
        </p>
      </div>
    </main>
  );
}
