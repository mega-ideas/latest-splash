import { NextResponse } from 'next/server';

import { readJsonBody } from '@/lib/server/http';
import {
  CctpUnavailable,
  crossChainReceiptView,
  irisClientFromEnv,
  mintReaderFromEnv,
  readCrossChainTransfer,
  recordCrossChainBurn,
  recordCrossChainMint,
  refreshCrossChainAttestation,
} from '@/lib/server/cross-chain-transfers';
import { corePackageOriginalIdFor } from '@/lib/payouts/withdrawal-rules';
import { NO_STORE, limitWalletRequests, requirePayoutReader, walletRoute } from '@/lib/server/wallet-route';
import { readWithdrawalTransaction } from '@/lib/server/withdrawals-deps';

export const dynamic = 'force-dynamic';

/**
 * The receipt of a cross-chain USDC payment over CCTP V2 (v2 §4.7, D5c),
 * by its intent id. Owners and staff of the business; another business's
 * payment reads as absent.
 *
 *   GET   the receipt: the Sui burn, Circle's attestation, the mint.
 *   POST  { burnDigest }   record the burn, read from Sui;
 *         { refresh: true } ask Circle for the attestation;
 *         { mintTxHash }   record the mint, read from the destination chain.
 * Nothing is signed or sent; each step is believed only from its source.
 */
function decodedRef(ref: string): string | null {
  try {
    return decodeURIComponent(ref);
  } catch {
    return null;
  }
}

const badRef = () => NextResponse.json({ error: 'Name the payment by its intent id.' }, { status: 400, headers: NO_STORE });

export async function GET(request: Request, { params }: { params: Promise<{ ref: string }> }) {
  const gate = await walletRoute(request);
  if (gate.response) return gate.response;
  const reader = requirePayoutReader(gate.route);
  if (reader) return reader;
  const { ref } = await params;
  const paymentRef = decodedRef(ref);
  if (!paymentRef) return badRef();
  const row = await readCrossChainTransfer(gate.route.db, gate.route.orgId, paymentRef);
  if (!row) return NextResponse.json({ error: 'No such cross-chain payment.' }, { status: 404, headers: NO_STORE });
  return NextResponse.json(crossChainReceiptView(row), { headers: NO_STORE });
}

export async function POST(request: Request, { params }: { params: Promise<{ ref: string }> }) {
  const gate = await walletRoute(request);
  if (gate.response) return gate.response;
  const reader = requirePayoutReader(gate.route);
  if (reader) return reader;
  // Each POST can ask Circle or a chain's RPC: limited per person and business.
  const limited = await limitWalletRequests(gate.route);
  if (limited) return limited;
  const { ref } = await params;
  const paymentRef = decodedRef(ref);
  if (!paymentRef) return badRef();
  const body = await readJsonBody(request);
  const { db, orgId } = gate.route;
  const base = { db, orgId, now: () => new Date() };
  let result;
  if (body.burnDigest !== undefined) {
    const original = corePackageOriginalIdFor(process.env);
    if (!original) return NextResponse.json({ error: 'The core package is not configured, so the burn cannot be read.' }, { status: 503, headers: NO_STORE });
    result = await recordCrossChainBurn(
      { ...base, readTransaction: readWithdrawalTransaction, corePackageOriginalId: original },
      { paymentRef, burnDigest: body.burnDigest },
    );
  } else if (body.mintTxHash !== undefined) {
    // Checked against Circle's contract on the network the receipt's attestation came from.
    result = await recordCrossChainMint({ ...base, mints: mintReaderFromEnv(process.env) }, { paymentRef, mintTxHash: body.mintTxHash });
  } else if (body.refresh === true) {
    let iris;
    try {
      iris = irisClientFromEnv(process.env);
    } catch (error) {
      if (error instanceof CctpUnavailable) return NextResponse.json({ error: error.message, code: error.code }, { status: 503, headers: NO_STORE });
      throw error;
    }
    result = await refreshCrossChainAttestation({ ...base, iris }, { paymentRef });
  } else {
    return NextResponse.json({ error: 'Send burnDigest, refresh or mintTxHash.' }, { status: 400, headers: NO_STORE });
  }
  if (!result.ok) return NextResponse.json({ error: result.error, code: result.code }, { status: result.status, headers: NO_STORE });
  return NextResponse.json(crossChainReceiptView(result.transfer), { headers: NO_STORE });
}
