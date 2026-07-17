import { redirectPreservingQuery, type LegacySearchParams } from '@/lib/legacy-redirect';

/** Legacy route — recipients are now Suppliers (relationship-first IA). */
export default async function LegacyRecipientsPage({ searchParams }: { searchParams: LegacySearchParams }) {
  await redirectPreservingQuery('/dashboard/suppliers', searchParams);
}
