'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';

import StepReceipts from '@/components/batch/StepReceipts';
import DashPageHeader from '@/components/dashboard/DashPageHeader';
import StepReceipt from '@/components/transfer/StepReceipt';

function Back() {
  return (
    <Link href="/dashboard/history" className="inline-flex min-h-11 items-center gap-1.5 text-[13px] font-semibold text-[#1F4452] hover:underline">
      <ArrowLeft className="h-4 w-4" aria-hidden="true" />
      All history
    </Link>
  );
}

/**
 * One payment's receipt, opened from History: the same card Transfer shows
 * when a payment is made, with the ways to share it. The reference names a
 * payment of the signed-in person's business; another business's reads as
 * absent (404), and the card says so.
 */
export function PaymentReceiptPage({ refId }: { refId: string }) {
  const router = useRouter();
  return (
    <div className="mx-auto w-full max-w-3xl space-y-5">
      <Back />
      <DashPageHeader kicker="Receipt" title="Payment receipt" />
      <section className="dash-surface p-4 sm:p-6">
        <StepReceipt refId={refId} onNew={() => router.push('/dashboard/transfer')} />
      </section>
    </div>
  );
}

/** A batch's receipts: one for each payment, and the totals. */
export function BatchReceiptPage({ batchId }: { batchId: string }) {
  const router = useRouter();
  return (
    <div className="mx-auto w-full max-w-4xl space-y-5">
      <Back />
      <DashPageHeader kicker="Receipts" title="Batch receipts" />
      <section className="dash-surface p-4 sm:p-6">
        <StepReceipts batchId={batchId} onNew={() => router.push('/dashboard/batch')} />
      </section>
    </div>
  );
}
