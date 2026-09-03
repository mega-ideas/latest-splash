import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import PostureFooter from '@/components/brand/PostureFooter';
import Wordmark from '@/components/brand/Wordmark';
import Receipt from '@/components/Receipt';
import { Badge } from '@/components/system';
import { brand } from '@/lib/brand';
import { explorerTxUrl, receiptNetworkLine } from '@/lib/network';
import { findReceiptShare } from '@/lib/server/receipt-share';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: `Receipt — ${brand.name}`,
  robots: { index: false, follow: false },
};

/**
 * Public, read-only receipt (the "Share with supplier" link).
 *
 * An unguessable token resolves one record and the page renders the SAME
 * Receipt component the operator sees, without login. Detail is
 * parties-only: anything the token does not name stays invisible, and the
 * page is never indexed. The statement-descriptor explainer tells the payee
 * why their bank shows the payout partner's name.
 */
export default async function SharedReceiptPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const share = findReceiptShare(token);
  if (!share) notFound();

  const { intent, audit, display } = share;
  const settled = Boolean(intent.suiTxDigest);
  const explorerUrl = intent.suiTxDigest ? explorerTxUrl(intent.suiTxDigest) : null;
  const history = audit?.statusHistory ?? [];
  const sentAt = history[0]?.at ?? intent.createdAt;
  const deliveredAt =
    history.find((entry) => entry.state === 'DISBURSED' || entry.state === 'CREDITED' || entry.state === 'SETTLED')?.at
    ?? (settled ? intent.updatedAt : undefined);

  return (
    <main className="min-h-dvh bg-[var(--paper)] px-4 py-8 text-[var(--text)] md:py-12">
      <div className="mx-auto grid w-full max-w-xl gap-5">
        <header className="flex items-center justify-between gap-3">
          <Wordmark size={28} />
          <Badge tone="slate">Read-only receipt</Badge>
        </header>

        <Receipt
          txDigest={intent.suiTxDigest ?? intent.receiptObjectId ?? 'Pending'}
          sender={`${brand.name} operator`}
          recipient={intent.recipientName}
          recipientName={intent.recipientName}
          amount={intent.sourceAmountUsd}
          currency="USD"
          fee={display.fee ?? '—'}
          fundingSource={intent.fundingMethod === 'BANK_USD' ? 'Bank USD' : intent.fundingMethod === 'HELD_BALANCE' ? `${brand.name} balance` : undefined}
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

        <section className="rounded-[16px] border border-[var(--line)] bg-[var(--surface)] p-4 text-[13px] leading-[1.55] text-[var(--text-2)]">
          <h2 className="text-[14px] font-semibold text-[var(--text)]">On your bank statement</h2>
          <p className="mt-1">
            The payout arrives through a licensed payout partner, so the statement shows the partner&apos;s legal name rather than {brand.name} or the payer.{' '}
            <Link href="/help/statement-descriptor" className="text-[var(--teal-600)] underline-offset-4 hover:underline">
              Why the partner&apos;s name appears
            </Link>
          </p>
        </section>

        <p className="text-center text-[12px] text-[var(--text-muted)]">Shared by the payer. This link shows this receipt only and is not indexed.</p>
        <PostureFooter className="text-center text-[12px] text-[var(--text-muted)]" />
      </div>
    </main>
  );
}
