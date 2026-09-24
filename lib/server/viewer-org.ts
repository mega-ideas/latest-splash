/**
 * The workspace a signed-in viewer belongs to — for pages, which answer by
 * rendering rather than with a response.
 *
 * From the membership row (`resolveAuthorityForSession`), never from the
 * session cookie's claims or the request: a session proves who someone is,
 * and only a membership says which workspace's data is theirs to see.
 *
 * `null` when there is no membership — the ordinary state of a brand-new
 * account, and also every session on a machine with no database, because
 * authority is never assumed. The page shows that viewer nothing that belongs
 * to anyone. Any other failure is thrown, so the page errors rather than
 * rendering an empty queue that reads as "nothing to approve".
 */
import 'server-only';

import { resolveAuthorityForSession, UnauthorizedError, type AuthorityContext } from '@/lib/auth/authority';
import type { CustomerSession } from '@/lib/auth/customer-session';

export async function viewerOrgId(
  session: CustomerSession,
  // A seam for tests; routes and pages use the membership table.
  resolve: (session: CustomerSession) => Promise<Pick<AuthorityContext, 'orgId'>> = resolveAuthorityForSession,
): Promise<string | null> {
  try {
    return (await resolve(session)).orgId;
  } catch (error) {
    if (error instanceof UnauthorizedError) return null;
    throw error;
  }
}
