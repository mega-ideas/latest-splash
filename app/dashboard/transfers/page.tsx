import { redirect } from 'next/navigation';

/**
 * Rate holds left the nav (v2 brief 5.1). A quote is still held for its
 * window in the backend and enforced at confirm; it is shown where it is
 * used, in Transfer, rather than on a page of its own.
 */
export default function RateHoldsPage() {
  redirect('/dashboard/transfer');
}
