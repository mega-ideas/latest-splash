import { PaymentReceiptPage } from '@/components/history/ReceiptPage';

/** One payment's or withdrawal's receipt, opened from History. */
export default async function Page({ params }: { params: Promise<{ ref: string }> }) {
  const { ref } = await params;
  let decoded = ref;
  try {
    decoded = decodeURIComponent(ref);
  } catch {
    /* a reference that is not valid UTF-8 percent-encoding is asked for as it is, and the server answers not found */
  }
  return <PaymentReceiptPage refId={decoded} />;
}
