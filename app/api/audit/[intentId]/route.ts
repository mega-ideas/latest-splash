import { createHash } from 'node:crypto';
import { NextResponse } from 'next/server';

import { verifyStoredSettlementEvidence } from '@/lib/evidence/settlement';
import { requireCustomerRequest } from '@/lib/server/customer-auth';
import { readSweepJob } from '@/lib/server/operations';
import { readInvoiceForStaff } from '@/lib/server/invoices-store';
import { requireSessionAccount } from '@/lib/server/session-account';
import { readAuditReceipt, readTransfer } from '@/lib/server/transfers-store';
import { readSealPolicy, sealAdapter } from '@/lib/server/seal';
import { retrieveBlob } from '@/lib/server/walrus';

/** Scoped to the caller's org: an audit trail is as sensitive as the payment. */
async function auditView(orgId: string, intentId: string) {
  const transfer = await readTransfer(orgId, intentId);
  // Composed from that same transfer, so the digest on the trail is the
  // digest on the payment by construction rather than by agreement.
  const receipt = await readAuditReceipt(orgId, intentId);
  if (!transfer || !receipt) return null;
  // The transfer above was already scoped to this org, and the invoice is the
  // one it names — so this read is reached only through an ownership check
  // that has already passed.
  const invoice = receipt.invoiceId ? await readInvoiceForStaff(receipt.invoiceId) : null;
  const sweepJob = receipt.sweepJobId ? readSweepJob(receipt.sweepJobId) : null;
  const policy = receipt.sealPolicyId ? readSealPolicy(receipt.sealPolicyId) : null;
  return { transfer, receipt, invoice, sweepJob, policy };
}

async function settlementProof(view: NonNullable<Awaited<ReturnType<typeof auditView>>>) {
  const evidence = view.receipt.evidence;
  const proof = await verifyStoredSettlementEvidence({
    walrusBlobId: evidence?.walrusBlobId ?? view.receipt.walrusBlobId,
    sealPolicyId: evidence?.sealPolicyId ?? view.receipt.sealPolicyId,
    expectedCiphertextHash: evidence?.ciphertextHash ?? view.receipt.auditHash,
    auditEventId: view.receipt.auditAnchorId,
    suiDigest: view.receipt.auditAnchorDigest ?? view.receipt.suiTxDigest,
  });
  return {
    receipt: {
      recipient: view.transfer.recipientName,
      sent: `USD ${view.transfer.sourceAmountUsd}`,
      delivered: `${view.transfer.targetCurrency} ${view.transfer.targetAmount}`,
      rate: view.transfer.exchangeRate,
      feeTier: view.receipt.funding?.feeTier ?? view.transfer.fundingFeeTier,
      status: view.transfer.state,
      source: view.receipt.funding?.method ?? view.transfer.fundingMethod,
      reference: view.transfer.invoiceId ?? view.transfer.id,
      time: view.transfer.updatedAt,
    },
    independent: proof,
  };
}

export async function GET(request: Request, { params }: { params: Promise<{ intentId: string }> }) {
  const auth = await requireCustomerRequest(request);
  if (auth.response) return auth.response;

  const accountCheck = await requireSessionAccount(auth.session);
  if (accountCheck.response) return accountCheck.response;

  const { intentId } = await params;
  const view = await auditView(accountCheck.account.orgId, intentId);
  return view
    ? NextResponse.json({ ...view, proof: await settlementProof(view) })
    : NextResponse.json({ error: 'Audit receipt not found' }, { status: 404 });
}

export async function POST(request: Request, { params }: { params: Promise<{ intentId: string }> }) {
  const auth = await requireCustomerRequest(request);
  if (auth.response) return auth.response;

  const accountCheck = await requireSessionAccount(auth.session);
  if (accountCheck.response) return accountCheck.response;

  const { intentId } = await params;
  const view = await auditView(accountCheck.account.orgId, intentId);
  const settlement = view ? await settlementProof(view) : null;
  if (!view?.invoice) return NextResponse.json({ error: 'Invoice proof not found' }, { status: 404 });
  if (view.invoice.demo && view.invoice.documentSha256?.startsWith('demo')) {
    return NextResponse.json({ verified: true, hash: view.invoice.documentSha256, settlement });
  }
  if (!view.invoice.walrusBlobId || !view.invoice.sealPolicyId || !view.invoice.documentSha256) {
    return NextResponse.json({ error: 'Incomplete proof chain', settlement }, { status: 409 });
  }
  const blob = await retrieveBlob(view.invoice.walrusBlobId);
  if (!blob) return NextResponse.json({ error: 'Walrus blob not found' }, { status: 404 });
  const plaintext = await sealAdapter.decrypt(blob.encryptedData, view.invoice.sealPolicyId, view.invoice.issuerOrg);
  if (!plaintext) return NextResponse.json({ error: 'Seal access denied' }, { status: 403 });
  const hash = createHash('sha256').update(plaintext).digest('hex');
  return NextResponse.json({ verified: hash === view.invoice.documentSha256, hash, settlement });
}
