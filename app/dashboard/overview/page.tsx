import { redirect } from 'next/navigation';

/** The overview's modeled figures are retired; Home carries the truthful first screen. */
export default function OverviewPage() {
  redirect('/dashboard');
}
