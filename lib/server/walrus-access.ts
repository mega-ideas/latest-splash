/**
 * Who may see a Walrus blob.
 *
 * A blob id is not a capability. `GET /api/walrus/:blobId` used to answer any
 * signed-in session for any id, and the ids are not secret: they appear on
 * invoices, receipts and evidence records. Every blob Splash writes is
 * sensitive (an encrypted invoice document, a settlement evidence bundle), so
 * the route treats them all the same way: it serves a blob only when the
 * caller's org owns an invoice or a transfer receipt that references it.
 *
 * The org is the session's (`requireSessionAccount`), never the request's.
 * An empty org or id owns nothing. Anything else, including a blob that
 * exists but belongs to another tenant, is the caller's 404.
 */
import { invoiceReferencesBlob } from './invoices-store.ts';
import { transferReferencesBlob } from './transfers-store.ts';

export async function orgReferencesBlob(orgId: string, blobId: string): Promise<boolean> {
  if (typeof orgId !== 'string' || !orgId || typeof blobId !== 'string' || !blobId) return false;
  if (await invoiceReferencesBlob(orgId, blobId)) return true;
  return transferReferencesBlob(orgId, blobId);
}
