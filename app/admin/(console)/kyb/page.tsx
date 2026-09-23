import AdminKybConsole from '@/components/admin/AdminKybConsole';
import { listKybCasesForStaff } from '@/lib/server/kyb';

export const dynamic = 'force-dynamic';

export default async function AdminKybPage() {
  return <AdminKybConsole initialCases={await listKybCasesForStaff()} />;
}
