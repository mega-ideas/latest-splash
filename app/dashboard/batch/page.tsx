import { redirectPreservingQuery, type LegacySearchParams } from '@/lib/legacy-redirect';

/** Legacy route — batch payouts now live under Payments › Runs. */
export default async function LegacyBatchPage({ searchParams }: { searchParams: LegacySearchParams }) {
  await redirectPreservingQuery('/dashboard/payments/runs', searchParams);
}
