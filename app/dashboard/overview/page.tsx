import { redirectPreservingQuery, type LegacySearchParams } from '@/lib/legacy-redirect';

/** Legacy route — the overview folded into the dashboard home (Action Queue + today strip). */
export default async function LegacyOverviewPage({ searchParams }: { searchParams: LegacySearchParams }) {
  await redirectPreservingQuery('/dashboard', searchParams);
}
