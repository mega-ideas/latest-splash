import { redirectPreservingQuery, type LegacySearchParams } from '@/lib/legacy-redirect';

/** Legacy route — settlement history now lives under Payments › History. */
export default async function LegacyHistoryPage({ searchParams }: { searchParams: LegacySearchParams }) {
  await redirectPreservingQuery('/dashboard/payments/history', searchParams);
}
