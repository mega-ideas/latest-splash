import { redirectPreservingQuery, type LegacySearchParams } from '@/lib/legacy-redirect';

/** Legacy route — the transfer wizard now lives under Payments › New. */
export default async function LegacyTransferPage({ searchParams }: { searchParams: LegacySearchParams }) {
  await redirectPreservingQuery('/dashboard/payments/new', searchParams);
}
