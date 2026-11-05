import ApproveDetail from '@/components/approve/ApproveDetail';

/** One request to sign, opened from the Approve list or from a link. A request that is not this business's reads as absent. */
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let decoded = id;
  try {
    decoded = decodeURIComponent(id);
  } catch {
    /* an id that is not valid percent-encoding is asked for as it is, and the server answers not found */
  }
  return <ApproveDetail id={decoded} />;
}
