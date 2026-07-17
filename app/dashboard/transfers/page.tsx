import { redirectPreservingQuery, type LegacySearchParams } from '@/lib/legacy-redirect';

/** Legacy route — rate holds now live under Payments › Rate holds. */
export default async function LegacyTransfersPage({ searchParams }: { searchParams: LegacySearchParams }) {
  await redirectPreservingQuery('/dashboard/payments/rate-holds', searchParams);
}
