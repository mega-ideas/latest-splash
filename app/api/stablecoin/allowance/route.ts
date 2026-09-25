import { NextResponse } from 'next/server';

import {
  explorerTxUrl,
  laneAccess,
  MIN_STABLECOIN_TRANSFER_MINOR,
  anchorFeeEnabled,
  gaslessEnabled,
  STABLECOIN_WINDOW_MS,
  type SuiNetwork,
} from '@/lib/payments/stablecoin-lane';
import { requireCustomerRequest } from '@/lib/server/customer-auth';
import { requireSessionAccount } from '@/lib/server/session-account';
import { listOutflows, readAllowance } from '@/lib/server/stablecoin-outflows';

export const dynamic = 'force-dynamic';

/**
 * The wallet lane as this workspace stands: which network it settles on, how
 * much of the 30-day allowance is used, whether the lane is open at all, and
 * the recent transfers. Read-only.
 */
export async function GET(request: Request) {
  const auth = await requireCustomerRequest(request);
  if (auth.response) return auth.response;
  const accountCheck = await requireSessionAccount(auth.session);
  if (accountCheck.response) return accountCheck.response;
  if (!process.env.DATABASE_URL) {
    return NextResponse.json({ error: 'Wallet transfers need the database.', code: 'ledger_unavailable' }, { status: 503 });
  }

  const { getDb } = await import('@/lib/db/client');
  const db = getDb();
  const orgId = accountCheck.account.orgId;
  const { state, network, allowance } = await readAllowance(db, orgId);
  const lane = laneAccess(state, 'STABLECOIN_WALLET');
  // Stablecoin transfers are free; only the audit-anchor fee (out of Splash,
  // when switched on) needs Splash's fee address.
  const anchorFeeOn = anchorFeeEnabled();
  const feeConfigured = !anchorFeeOn || Boolean(process.env.SPLASH_FEE_ADDRESS_MAINNET);
  const rows = await listOutflows(db, orgId, 20);
  const { readOrgSettings } = await import('@/lib/server/org-settings');
  const settings = await readOrgSettings(orgId);
  // WhatsApp style is only switched on when the main admin can approve, but
  // they can lose that afterwards (a removed passkey), so it is asked again.
  const { whatsappApprovalsReady } = await import('@/lib/server/step-up-gate');
  const approvalReady = settings.whatsappEnabled ? await whatsappApprovalsReady(orgId, 'approve') : { ok: true as const };

  return NextResponse.json({
    network: network as SuiNetwork,
    kybState: state,
    verified: state === 'ACTIVE',
    lane: { open: lane.allowed && feeConfigured, reason: !lane.allowed ? lane.reason : feeConfigured ? '' : 'Wallet transfers are not open yet: Splash’s mainnet fee address is not configured.' },
    // x402 carries no Splash fee, so it does not wait on the fee address.
    x402: { open: laneAccess(state, 'X402').allowed, reason: laneAccess(state, 'X402').reason },
    allowance: {
      usedMinor: allowance.usedMinor.toString(),
      remainingMinor: allowance.remainingMinor.toString(),
      windowCapMinor: allowance.windowCapMinor.toString(),
      windowDays: STABLECOIN_WINDOW_MS / 86_400_000,
    },
    pricing: { anchorFeeOn },
    // Wallet transfers carry no network fee while this is on; each quote
    // still says how its own gas is paid (it can fall back). x402 always
    // needs a little SUI.
    gas: { gasless: gaslessEnabled() },
    minimumMinor: MIN_STABLECOIN_TRANSFER_MINOR.toString(),
    screeningConfigured: Boolean(process.env.CHAINALYSIS_SANCTIONS_API_KEY),
    // How a transfer is approved here (Settings): WhatsApp code + passkey, or a
    // click — with a second person when dual approval is on and the amount
    // reaches the threshold.
    approval: {
      style: settings.whatsappEnabled ? 'WHATSAPP_PASSKEY' : 'CLICK',
      requireDualApproval: settings.requireDualApproval,
      approvalThresholdUsd: settings.approvalThresholdUsd,
      ready: approvalReady.ok,
      readyReason: approvalReady.ok ? '' : approvalReady.reason,
    },
    outflows: rows.map((r: {
      id: string; kind: string; status: string; network: string; principalMinor: bigint; feeMinor: bigint;
      recipientAddress: string; supplierId: string | null; txDigest: string | null; anchorStatus: string;
      resource: string | null; failureReason: string | null; createdAt: Date; confirmedAt: Date | null; reservedUntil: Date;
    }) => ({
      id: r.id,
      kind: r.kind,
      status: r.status,
      network: r.network,
      principalMinor: String(r.principalMinor),
      feeMinor: String(r.feeMinor),
      recipientAddress: r.recipientAddress,
      supplierId: r.supplierId,
      txDigest: r.txDigest,
      explorerUrl: r.txDigest ? explorerTxUrl(r.network as SuiNetwork, r.txDigest) : null,
      anchorStatus: r.anchorStatus,
      resource: r.resource,
      failureReason: r.failureReason,
      createdAt: new Date(r.createdAt).toISOString(),
      reservedUntil: new Date(r.reservedUntil).toISOString(),
      confirmedAt: r.confirmedAt ? new Date(r.confirmedAt).toISOString() : null,
    })),
  }, { headers: { 'Cache-Control': 'no-store' } });
}
