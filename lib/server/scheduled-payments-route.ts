/**
 * What every scheduled-batches route shares: the fields of a body that may be
 * read (a schedule is named by ids the business already has, never by a name or
 * an address in a request), and a service refusal as the response every wallet
 * route answers with. The gate (scheduleRoute) takes the business and the
 * person from the session; nothing here reads either from the request.
 */
import 'server-only';

import type { ItemInput } from '@/lib/server/scheduled-payments';

/** Items from a request body: an id, an amount and a reference, and nothing else carried over. At most one more than the cap, so the service can say it is too many. */
export function itemsFromBody(value: unknown): ItemInput[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 21).map((raw) => {
    const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const str = (v: unknown) => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');
    return { recipientId: str(r.recipientId), businessId: str(r.businessId), amount: str(r.amount), reference: str(r.reference) };
  });
}
