import { redirect } from 'next/navigation';

export type { TransferState } from '@/lib/send/state';

/** The Send flow lives at /dashboard/send; deep links keep their query. */
export default async function TransferRedirect({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === 'string') query.set(key, value);
  }
  const suffix = query.toString();
  redirect(suffix ? `/dashboard/send?${suffix}` : '/dashboard/send');
}
