import { headers } from 'next/headers';

import GoLiveView from '@/components/admin/GoLiveView';
import { adminConsolePath } from '@/lib/admin-routing';
import { runHealthChecks } from '@/lib/server/health-checks';

export const dynamic = 'force-dynamic';

/**
 * Go-live: the checks `npm run doctor` prints, run on this server, for staff
 * who have no terminal on it. Same module as doctor and GET /api/health
 * (lib/server/health-checks.ts), so the three cannot disagree. Staff-only by
 * the console layout. Nothing here sends a message or moves money: Twilio is
 * an account lookup, screening a probe of the zero address, prices are reads.
 */
export default async function GoLivePage() {
  const [report, headerStore] = await Promise.all([runHealthChecks(), headers()]);
  return <GoLiveView report={report} rerunHref={adminConsolePath('/go-live', headerStore.get('host'))} />;
}
