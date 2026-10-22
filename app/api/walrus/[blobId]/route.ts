import { NextResponse } from 'next/server';

import { requireCustomerRequest } from '@/lib/server/customer-auth';
import { requireSessionAccount } from '@/lib/server/session-account';
import { retrieveBlob, WalrusAdapterError } from '@/lib/server/walrus';
import { orgReferencesBlob } from '@/lib/server/walrus-access';

export const dynamic = 'force-dynamic';

/** Sensitive whatever it holds: never stored by a browser or a shared cache. */
const NO_STORE = { 'Cache-Control': 'private, no-store' };

function notFound() {
  return NextResponse.json({ error: 'Walrus blob not found' }, { status: 404, headers: NO_STORE });
}

/**
 * Metadata for one Walrus blob, to the org that owns it.
 *
 * Served only when the caller's org owns an invoice or a transfer receipt that
 * references the blob id (lib/server/walrus-access.ts). Another tenant's blob
 * gets the same 404 as a blob that does not exist, and the check runs before
 * the blob is fetched, so the answer does not depend on whether it exists.
 */
export async function GET(request: Request, { params }: { params: Promise<{ blobId: string }> }) {
  const auth = await requireCustomerRequest(request);
  if (auth.response) return auth.response;
  const accountCheck = await requireSessionAccount(auth.session);
  if (accountCheck.response) return accountCheck.response;

  const { blobId } = await params;
  if (!(await orgReferencesBlob(accountCheck.account.orgId, blobId))) return notFound();

  try {
    const blob = await retrieveBlob(blobId);
    if (!blob) return notFound();
    return NextResponse.json(
      {
        blobId: blob.blobId,
        sizeBytes: blob.sizeBytes,
        epochs: blob.epochs,
        mode: blob.mode,
        createdAt: blob.createdAt,
      },
      { headers: NO_STORE },
    );
  } catch (error) {
    if (error instanceof WalrusAdapterError) {
      return NextResponse.json({ error: error.message }, { status: error.status, headers: NO_STORE });
    }
    return NextResponse.json({ error: 'Walrus proof unavailable' }, { status: 500, headers: NO_STORE });
  }
}
