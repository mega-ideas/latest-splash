import { redirectPreservingQuery, type LegacySearchParams } from '@/lib/legacy-redirect';

/** Legacy route — the Action Queue is now the dashboard home. */
export default async function LegacyQueuePage({ searchParams }: { searchParams: LegacySearchParams }) {
  await redirectPreservingQuery('/dashboard', searchParams);
}
