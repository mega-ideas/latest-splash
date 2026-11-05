import { BatchReceiptPage } from '@/components/history/ReceiptPage';

/** One batch's receipts, opened from History. */
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let decoded = id;
  try {
    decoded = decodeURIComponent(id);
  } catch {
    /* asked for as it is; the server answers not found */
  }
  return <BatchReceiptPage batchId={decoded} />;
}
