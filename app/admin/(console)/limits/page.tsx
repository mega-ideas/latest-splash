import AdminLimitRequests from '@/components/admin/AdminLimitRequests';
import { getAdminSession } from '@/lib/server/admin-auth';
import { LIMIT_DECIDER_ROLES, listLimitRequestsForStaff } from '@/lib/server/business-limits';
import type { DrizzleDb } from '@/lib/server/wallet-signing-store';

export const dynamic = 'force-dynamic';

/**
 * Owners' requests for higher limits on automatic payments. Compliance and
 * operations staff decide them; support does not see them. Cross-tenant, through
 * the *ForStaff service function.
 */
export default async function AdminLimitRequestsPage() {
  const session = await getAdminSession();
  const allowed = Boolean(session && (LIMIT_DECIDER_ROLES as readonly string[]).includes(session.role));
  const empty = { open: [], recent: [] };
  if (!session || !allowed) return <AdminLimitRequests initial={empty} allowed={false} problem={null} />;
  if (!process.env.DATABASE_URL) return <AdminLimitRequests initial={empty} allowed problem="No database is connected here, so there are no requests to show." />;
  const { getDb } = await import('@/lib/db/client');
  const result = await listLimitRequestsForStaff(getDb() as unknown as DrizzleDb, { email: session.email, role: session.role });
  if (!result.ok) return <AdminLimitRequests initial={empty} allowed problem={result.error} />;
  return <AdminLimitRequests initial={{ open: result.open, recent: result.recent }} allowed problem={null} />;
}
