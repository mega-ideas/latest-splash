/**
 * Which orgs a number could be approving for.
 *
 * A WhatsApp reply carries a number and nothing else — no org, no proposal. One
 * person can hold approver roles in more than one workspace, so the number has
 * to be resolved to a set of candidates and then narrowed by which of them
 * actually has a payment waiting on them.
 *
 * Kept apart from `approver-channels.ts` on purpose. That module answers "may
 * THIS person approve THIS payment", which is an authority question and takes
 * the org from the proposal. This one answers "where might this number matter",
 * which is a routing question. Letting the number choose the org would invert
 * the first module's whole point.
 */
import 'server-only';

import { eq } from 'drizzle-orm';

import { approverChannels } from '@/lib/db/schema';
import { normaliseE164 } from '@/lib/server/whatsapp';

export async function findApproverOrgsForNumber(rawNumber: string): Promise<string[]> {
  const e164 = normaliseE164(rawNumber);
  if (!e164 || !process.env.DATABASE_URL) return [];

  const { getDb } = await import('@/lib/db/client');
  const rows = await getDb()
    .select({ orgId: approverChannels.orgId, verifiedAt: approverChannels.verifiedAt })
    .from(approverChannels)
    .where(eq(approverChannels.whatsappE164, e164));

  // Unverified rows are excluded here as well as in the authority check. A
  // number nobody proved should not even narrow the search.
  return rows.filter((row) => row.verifiedAt !== null).map((row) => row.orgId);
}
