import { redirect } from 'next/navigation';

/**
 * IA restructure (suppliers-first): legacy dashboard routes 302 to their
 * successors. Same pattern as app/dashboard/0xwal/page.tsx, plus query-string
 * preservation so deep links like /dashboard/transfer?invoiceId=… keep working
 * across the move. (Next's redirect() emits the framework's temporary
 * redirect — never a 301/308 — so old URLs are not cached as permanent.)
 */
export type LegacySearchParams = Promise<Record<string, string | string[] | undefined>>;

export async function redirectPreservingQuery(target: string, searchParams: LegacySearchParams): Promise<never> {
  const params = await searchParams;
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === 'string') query.set(key, value);
    else if (Array.isArray(value)) for (const item of value) query.append(key, item);
  }
  const suffix = query.toString();
  redirect(suffix ? `${target}?${suffix}` : target);
}
