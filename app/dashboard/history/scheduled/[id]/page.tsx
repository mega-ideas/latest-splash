import ScheduledReceipt from '@/components/schedule/ScheduledReceipt';

/** One scheduled run paid automatically, opened from History. */
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let decoded = id;
  try {
    decoded = decodeURIComponent(id);
  } catch {
    /* asked for as it is; the server answers not found */
  }
  return <ScheduledReceipt runId={decoded} />;
}
