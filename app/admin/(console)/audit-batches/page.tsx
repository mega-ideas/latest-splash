import AdminAuditBatches from '@/components/admin/AdminAuditBatches';
import { listDailyAuditBatchesForStaff } from '@/lib/server/audit-batches';

export const dynamic = 'force-dynamic';

/**
 * Daily audit batches, for staff. A batch spans every tenant, so since WS2 it
 * is readable only here: the customer History page no longer shows it.
 */
export default function AdminAuditBatchesPage() {
  return <AdminAuditBatches initialBatches={listDailyAuditBatchesForStaff()} />;
}
