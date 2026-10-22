import AdminProfileRequests from '@/components/admin/AdminProfileRequests';
import { listProfileRequestsForStaff } from '@/lib/server/customer-profile';

export const dynamic = 'force-dynamic';

export default function AdminProfileRequestsPage() {
  return <AdminProfileRequests initialRequests={listProfileRequestsForStaff()} />;
}
