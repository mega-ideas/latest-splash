import { NextResponse } from 'next/server';
import { z } from 'zod';

import { resolveAuthorityForSession, UnauthorizedError } from '@/lib/auth/authority';
import {
  buildServiceOrderStep,
  listServiceOrders,
  readServiceOrder,
  ServiceOrderError,
  settleServiceOrder,
  submitServiceOrderStep,
} from '@/lib/server/composed-payment';
import { requireCustomerRequest } from '@/lib/server/customer-auth';
import { readJsonBody } from '@/lib/server/http';
import { refuseOutsideLaunchScope } from '@/lib/server/launch-scope';
import { listUserPasskeySigners, signerBelongsToUser } from '@/lib/server/member-signers';
import { completeDeliveryForTransfer } from '@/lib/server/sweep';
import { patchTransfer } from '@/lib/server/transfers-store';

/**
 * WS3 — the two member signatures of a service order, and the operator's.
 *
 *   GET                           this workspace's orders in flight, who has
 *                                 signed each, and the window left, read off
 *                                 the intent on chain
 *   POST { action: 'build' }      compose signature one (the maker's
 *                                 create_service_order) or two (a different
 *                                 approver's approve_payout) as unsigned bytes
 *                                 for that member's own wallet
 *   POST { action: 'submit' }     relay the member's signed bytes; once the
 *                                 approval lands the operator signs the third
 *                                 and pays exactly what was approved
 *
 * No key the browser holds ever reaches this server, and the operator key
 * signs only the third signature — never the first two.
 */

export const dynamic = 'force-dynamic';

const buildSchema = z.object({
  action: z.literal('build'),
  orderId: z.string().min(1),
  step: z.enum(['order', 'approve']),
  signer: z.string().regex(/^0x[0-9a-fA-F]{1,64}$/),
});

const submitSchema = z.object({
  action: z.literal('submit'),
  orderId: z.string().min(1),
  step: z.enum(['order', 'approve']),
  bytes: z.string().min(1),
  signature: z.string().min(1),
});

async function authority(request: Request) {
  const auth = await requireCustomerRequest(request);
  if (auth.response) return { response: auth.response, ctx: null };
  const outOfScope = refuseOutsideLaunchScope();
  if (outOfScope) return { response: outOfScope, ctx: null };
  try {
    return { response: null, ctx: await resolveAuthorityForSession(auth.session) };
  } catch (error) {
    if (!(error instanceof UnauthorizedError)) throw error;
    return {
      response: NextResponse.json(
        { error: 'This account has no workspace membership, so it cannot sign a payment.', code: 'no_membership' },
        { status: 403 },
      ),
      ctx: null,
    };
  }
}

function refusal(error: unknown) {
  if (error instanceof ServiceOrderError) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }
  return NextResponse.json(
    { error: error instanceof Error ? error.message : 'The service order could not be processed.' },
    { status: 502 },
  );
}

export async function GET(request: Request) {
  const { response, ctx } = await authority(request);
  if (response) return response;
  const [orders, passkeys] = await Promise.all([listServiceOrders(ctx.orgId), listUserPasskeySigners(ctx.userId)]);
  return NextResponse.json(
    { viewer: { userId: ctx.userId, role: ctx.role }, orders, passkeys, now: Date.now() },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}

export async function POST(request: Request) {
  const { response, ctx } = await authority(request);
  if (response) return response;
  const body = await readJsonBody(request);

  if (body.action === 'build') {
    const parsed = buildSchema.safeParse(body);
    if (!parsed.success) return NextResponse.json({ error: 'Invalid build request' }, { status: 400 });
    // The address must be this member's own passkey or zkLogin wallet, so the
    // order records a person rather than an address someone typed.
    if (!(await signerBelongsToUser(ctx.userId, parsed.data.signer))) {
      return NextResponse.json(
        { error: 'That signer is not one of your enrolled wallets. Sign with your own passkey or zkLogin wallet.' },
        { status: 403 },
      );
    }
    try {
      const built = await buildServiceOrderStep({
        orgId: ctx.orgId,
        orderId: parsed.data.orderId,
        step: parsed.data.step,
        signer: parsed.data.signer,
        userId: ctx.userId,
      });
      return NextResponse.json(built, { headers: { 'Cache-Control': 'no-store' } });
    } catch (error) {
      return refusal(error);
    }
  }

  if (body.action === 'submit') {
    const parsed = submitSchema.safeParse(body);
    if (!parsed.success) return NextResponse.json({ error: 'Invalid submit request' }, { status: 400 });
    let view;
    try {
      view = await submitServiceOrderStep({
        orgId: ctx.orgId,
        orderId: parsed.data.orderId,
        step: parsed.data.step,
        bytes: parsed.data.bytes,
        signature: parsed.data.signature,
        userId: ctx.userId,
        role: ctx.role,
      });
    } catch (error) {
      return refusal(error);
    }
    if (parsed.data.step === 'order') return NextResponse.json({ order: view });

    // Signature two landed: the operator signs the third, now, while the
    // window the contract opened the order with is still open.
    await patchTransfer(view.transferId, { state: 'SETTLING' });
    try {
      const result = await settleServiceOrder({ orgId: ctx.orgId, orderId: view.id });
      await patchTransfer(result.transferId, {
        state: 'SETTLED',
        suiTxDigest: result.digest,
        verificationReference: result.digest,
        receiptObjectId: result.auditAnchorObjectId ?? undefined,
        paymentIntentId: result.intentId,
        intentCreateDigest: result.intentCreateDigest,
        walrusBlobId: result.walrus.blobId,
        sealPolicyId: result.sealPolicy.policyId,
        auditHash: result.auditHash,
        auditAnchorId: result.auditAnchorObjectId ?? undefined,
        auditAnchorDigest: result.digest,
        evidence: result.evidence,
        composedActions: result.composedActions,
      });
      await completeDeliveryForTransfer(result.transferId);
      return NextResponse.json({ order: await readServiceOrder(ctx.orgId, view.id), digest: result.digest });
    } catch (error) {
      await patchTransfer(view.transferId, {
        state: 'FAILED',
        failureReason: error instanceof Error ? error.message : 'Unknown settlement error',
        failedAtState: 'SETTLING',
      });
      return refusal(error);
    }
  }

  return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
}
