import AdminMemberships from '@/components/admin/AdminMemberships';
import { listAccounts, listOrganizations } from '@/lib/server/memberships';

/**
 * Granting a membership is the one operator action Phase 3 left without a
 * surface. Everything else about authority reads from the database on every
 * request; this is where the rows come from.
 */
export const dynamic = 'force-dynamic';

export default async function AdminMembershipsPage() {
  // No DATABASE_URL means no memberships to read and none that could be
  // granted. Say that rather than throwing a connection error at an operator
  // who cannot do anything about it from here.
  if (!process.env.DATABASE_URL) {
    return (
      <div className="mx-auto max-w-3xl">
        <h1 className="text-2xl font-black tracking-[-0.02em] text-[#1f4350]">Workspace access</h1>
        <p className="mt-3 rounded-2xl border border-[#E39774]/45 bg-[#E39774]/10 p-5 text-sm leading-relaxed text-[#9a4a2d]">
          Account storage is not configured on this deployment. <code>DATABASE_URL</code> is unset, so there are no
          accounts to list and no membership can be granted. Memberships are the only source of authority — there is
          no fallback that assumes one.
        </p>
      </div>
    );
  }

  const { getDb } = await import('@/lib/db/client');
  const db = getDb() as never;
  const [accounts, organizations] = await Promise.all([listAccounts(db), listOrganizations(db)]);

  return <AdminMemberships initialAccounts={accounts} organizations={organizations} />;
}
