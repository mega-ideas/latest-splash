import { redirectPreservingQuery, type LegacySearchParams } from '@/lib/legacy-redirect';

/** Payments landing — the New payment tab is the default entry. */
export default async function PaymentsIndexPage({ searchParams }: { searchParams: LegacySearchParams }) {
  await redirectPreservingQuery('/dashboard/payments/new', searchParams);
}
