import { redirect } from 'next/navigation';

/** The overview is Home now (v2 brief 5.1): keep old deep links working. */
export default function OverviewPage() {
  redirect('/dashboard');
}
