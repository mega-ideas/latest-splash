import { fromBase64, toBase64 } from '@mysten/sui/utils';

import type { UserRole } from '@/lib/agent/types';
import {
  explorerTxUrl,
  normaliseSuiAddress,
  STABLECOIN_NETWORK,
  StablecoinLaneError,
  SUI_USDC_COIN_TYPE,
} from '@/lib/payments/stablecoin-lane';
import { outflowAuditHash, verifyStablecoinTransfer, type ExpectedTransfer } from '@/lib/payments/stablecoin-verify';
import {
  parsePaymentRequired,
  parseSettlement,
  paymentHeader,
  selectSuiRequirement,
  X402Error,
  type X402Accept,
  type X402PaymentRequired,
} from '@/lib/payments/x402-sui';
import type { SafeResponse } from '@/lib/server/safe-fetch';
import type { SendDeps } from '@/lib/server/stablecoin-send';
import { bindOutflowDigest, closeOutflow, confirmOutflow, readOutflow, reserveOutflow } from '@/lib/server/stablecoin-outflows';
import { stablecoinTransferSubject } from '@/lib/server/step-up-subjects';
import type { WalletScreening } from '@/lib/server/wallet-screening';

/**
 * Paying an x402 seller in USDC on Sui mainnet — outside Zeke, which only
 * quotes, and against the SAME allowance as wallet transfers.
 *
 *   probe  fetch the resource; a 402 carries the seller's price. Splash reads
 *          the price itself, every time — a pasted price is never trusted.
 *   quote  screen the payee, reserve the amount (kind X402, no Splash fee),
 *          and build the exact transfer from the buyer's own coins.
 *   pay    with the approval spent and the signed bytes dry-run and matched,
 *          re-read the price (it must not have changed), send the signed
 *          payment to the seller in PAYMENT-SIGNATURE, and let the seller's
 *          facilitator broadcast it. Then read the digest back from the chain
 *          and record what actually happened.
 *
 * Unlike a wallet transfer, Splash does NOT submit the transaction: in x402
 * the seller's facilitator does. Splash's guarantees are that what was signed
 * is exactly the quoted payment, and that the record matches the chain.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any;

export interface X402Deps extends Pick<SendDeps, 'chain' | 'approval' | 'now'> {
  db: Db;
  get(url: string, init?: { headers?: Record<string, string>; timeoutMs?: number }): Promise<SafeResponse>;
  screen(address: string): Promise<WalletScreening>;
  /** Wait between chain reads after the seller says it settled. */
  sleep?: (ms: number) => Promise<void>;
}

type Fail = { ok: false; status: number; code: string; error: string; allowance?: unknown };
const fail = (status: number, code: string, error: string, extra: Record<string, unknown> = {}): Fail => ({ ok: false, status, code, error, ...extra });

const SENDER_ROLES: ReadonlySet<UserRole> = new Set(['OWNER', 'FINANCE_ADMIN', 'MAKER']);
const ATTESTING_ROLES: ReadonlySet<UserRole> = new Set(['OWNER', 'FINANCE_ADMIN']);
const USDC = SUI_USDC_COIN_TYPE[STABLECOIN_NETWORK];

function tryJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// ─── Probe ──────────────────────────────────────────────────────────────────

export async function probeX402(deps: Pick<X402Deps, 'get'>, url: string): Promise<
  | { ok: true; pr: X402PaymentRequired; accept: X402Accept; payTo: string }
  | (Fail & { pr?: X402PaymentRequired })
> {
  let res: SafeResponse;
  try {
    res = await deps.get(url, { timeoutMs: 15_000 });
  } catch (error) {
    return fail(422, 'unreachable', error instanceof Error ? error.message : 'The resource could not be reached.');
  }
  if (res.status !== 402) {
    return fail(422, 'not_402', res.status === 200
      ? 'This resource did not ask for payment — it answered 200.'
      : `The resource answered ${res.status}, not 402 Payment Required.`);
  }
  let pr: X402PaymentRequired;
  try {
    pr = parsePaymentRequired({ header: res.headers.get('payment-required'), body: tryJson(res.body) }, url);
  } catch (error) {
    return fail(422, 'not_x402', error instanceof X402Error ? error.message : 'Not an x402 payment request.');
  }
  const pick = selectSuiRequirement(pr);
  if (!pick.ok) return { ...fail(422, 'not_payable', pick.reason), pr };
  return { ok: true, pr, accept: pick.accept, payTo: pick.payTo };
}

// ─── Quote ──────────────────────────────────────────────────────────────────

export async function quoteX402(
  deps: X402Deps,
  input: { orgId: string; userId: string; role: UserRole; url: string; senderAddress: string; attestPayee?: boolean },
) {
  if (!SENDER_ROLES.has(input.role)) return fail(403, 'role_cannot_send', 'Your role can view payments but not start one.');
  let sender: string;
  try {
    sender = normaliseSuiAddress(String(input.senderAddress ?? ''));
  } catch (error) {
    return fail(400, 'invalid_input', error instanceof StablecoinLaneError ? error.message : 'Invalid sender address.');
  }

  const probe = await probeX402(deps, input.url);
  if (!probe.ok) return probe;
  const { pr, accept, payTo } = probe;
  if (payTo === sender) return fail(400, 'self_payment', 'The seller’s payTo is the wallet you are paying from.');

  // The payee is a stranger's address: the same sanctions floor as a saved
  // wallet recipient — screened, or an admin vouching by name.
  const screening = await deps.screen(payTo);
  if (screening.verdict === 'BLOCK') return fail(403, 'payee_blocked', 'This seller’s wallet is on a sanctions list. Splash will not pay it.');
  if (screening.verdict === 'ERROR') return fail(403, 'payee_unscreened', 'Screening could not complete for this seller’s wallet. Try again.');
  if (screening.verdict === null) {
    if (!input.attestPayee) {
      return fail(403, 'payee_unscreened', 'This seller’s wallet has not been screened (no screening provider is configured). An admin can attest to knowing this seller to pay it.');
    }
    if (!ATTESTING_ROLES.has(input.role)) return fail(403, 'not_admin', 'Only an admin can attest to an unscreened seller.');
  }

  const reserved = await reserveOutflow(deps.db, {
    orgId: input.orgId,
    kind: 'X402',
    supplierId: null,
    coinType: USDC,
    principalMinor: accept.amountMinor,
    feeMinor: 0n,
    senderAddress: sender,
    recipientAddress: payTo,
    feeAddress: null,
    // The URL the user asked for and Splash fetched — NOT the resource.url the
    // seller declares about itself, which could name any server at all. The
    // signed payment is only ever sent back to where the price came from.
    resource: new URL(input.url).toString(),
    requestedBy: input.userId,
    nowMs: deps.now?.(),
  });
  if (!reserved.ok) {
    const a = reserved.allowance;
    return fail(409, 'allowance', reserved.reason, a ? { allowance: { usedMinor: a.usedMinor.toString(), remainingMinor: a.remainingMinor.toString(), windowCapMinor: a.windowCapMinor.toString() } } : {});
  }

  let bytes: Uint8Array;
  try {
    // Never gasless: the seller's facilitator broadcasts this, and the x402
    // Sui scheme is a coin transfer the buyer pays gas for (x402-sui.ts).
    bytes = await deps.chain.build({ sender, coinType: USDC, legs: [{ address: payTo, amountMinor: accept.amountMinor }], gas: 'SENDER_PAYS' });
  } catch (error) {
    await closeOutflow(deps.db, { orgId: input.orgId, id: reserved.id, status: 'FAILED', reason: 'could not build' });
    return fail(422, 'cannot_build', deps.chain.describeBuildError(error));
  }

  return {
    ok: true as const,
    outflowId: reserved.id,
    resource: pr.resource,
    x402Version: pr.x402Version,
    amountMinor: accept.amountMinor.toString(),
    payTo,
    senderAddress: sender,
    payeeScreening: screening.verdict ?? 'ATTESTED',
    reservedUntil: reserved.reservedUntil.toISOString(),
    gas: 'SENDER_PAYS' as const,
    transactionBytes: toBase64(bytes),
  };
}

// ─── Pay ────────────────────────────────────────────────────────────────────

export async function payX402(
  deps: X402Deps,
  input: { orgId: string; role: UserRole; outflowId: string; transactionBytes: string; signature: string },
) {
  if (!SENDER_ROLES.has(input.role)) return fail(403, 'role_cannot_send', 'Your role can view payments but not start one.');
  const row = await readOutflow(deps.db, input.orgId, input.outflowId);
  if (!row || row.kind !== 'X402') return fail(404, 'quote_not_found', 'x402 quote not found.');
  if (row.status === 'CONFIRMED') return confirmedView(row, null);
  if (row.status !== 'PENDING') return fail(409, 'quote_closed', `This x402 quote is ${String(row.status).toLowerCase()}. Start again.`);

  let bytes: Uint8Array;
  try {
    bytes = fromBase64(String(input.transactionBytes ?? ''));
  } catch {
    return fail(400, 'invalid_bytes', 'The signed transaction could not be read.');
  }
  if (bytes.length === 0 || !input.signature) return fail(400, 'invalid_bytes', 'A signed transaction and its signature are required.');
  let signer: string | null = null;
  try {
    signer = deps.chain.senderOf(bytes);
  } catch {
    signer = null;
  }
  if (!signer || normaliseSuiAddress(signer) !== normaliseSuiAddress(row.senderAddress)) {
    return fail(400, 'wrong_sender', 'This payment was prepared for a different wallet than the one that signed it.');
  }

  const expected: ExpectedTransfer = {
    sender: row.senderAddress,
    coinType: row.coinType,
    legs: [{ address: row.recipientAddress, amountMinor: BigInt(row.principalMinor) }],
  };
  const digest = deps.chain.digestOf(bytes);

  // One signed payment per quote: once one has gone to the seller, it is the
  // only one that may settle this quote.
  if (row.txDigest && row.txDigest !== digest) {
    const first = await deps.chain.read(row.txDigest);
    if (first) return settle(deps, row, expected, first, null);
    return fail(409, 'already_sent', 'A signed payment for this quote was already sent to the seller and may still land. Wait for it, or start again once this quote expires.');
  }

  // Already on chain (a retry after the seller answered, or a facilitator
  // that was slow): record it rather than pay twice.
  const already = await deps.chain.read(digest);
  if (already) return settle(deps, row, expected, already, null);

  if (new Date(row.reservedUntil).getTime() <= (deps.now?.() ?? Date.now())) {
    await closeOutflow(deps.db, { orgId: input.orgId, id: row.id, status: 'EXPIRED', reason: 'quote lapsed before payment' });
    return fail(410, 'quote_expired', 'This x402 quote expired before it was paid. Nothing moved. Start again.');
  }

  const subject = stablecoinTransferSubject(row, '');
  // A resend of the SAME bound payment already spent its approval.
  const resend = row.txDigest === digest;
  if (!resend && !(await deps.approval.consume({ orgId: input.orgId, subjectId: row.id, subject: subject.subject }))) {
    return fail(428, 'approval_required', 'This x402 payment has not been approved yet. Approve it first, then sign.');
  }
  const handBack = async () => {
    if (!resend) await deps.approval.release({ orgId: input.orgId, subjectId: row.id });
  };

  let dry: Awaited<ReturnType<X402Deps['chain']['simulate']>>;
  try {
    dry = await deps.chain.simulate(bytes);
  } catch (error) {
    // Refused or unanswered before anything left Splash: the approval goes back.
    await handBack();
    if (deps.chain.isTransient?.(error)) {
      return fail(503, 'chain_busy', 'The Sui network node did not answer the check before paying. Nothing was paid. Try again in a moment.');
    }
    return fail(422, 'preflight_refused', `Not paid — Sui refused the transaction on the check before paying. ${error instanceof Error ? error.message : String(error)}`);
  }
  const preflight = verifyStablecoinTransfer(expected, dry);
  if (!preflight.ok) {
    await handBack();
    return fail(409, 'preflight_mismatch', `Not paid — the signed transaction does not match the quote. ${preflight.reason}`);
  }

  // The seller's price must be the one that was approved.
  const probe = await probeX402(deps, String(row.resource));
  if (!probe.ok) {
    await handBack();
    return fail(409, 'seller_changed', `Not paid — the seller’s payment request changed or disappeared: ${probe.error}`);
  }
  if (probe.accept.amountMinor !== BigInt(row.principalMinor) || probe.payTo !== normaliseSuiAddress(row.recipientAddress)) {
    await handBack();
    return fail(409, 'seller_changed', 'Not paid — the seller changed the price or the payee since this was approved. Start again.');
  }

  // From here the signed payment leaves Splash: bind the quote to it.
  if (!(await bindOutflowDigest(deps.db, { orgId: input.orgId, id: row.id, txDigest: digest }))) {
    return fail(409, 'already_sent', 'Another payment was sent for this quote first. Refresh to see where it stands.');
  }

  const header = paymentHeader(probe.pr, probe.accept, { transaction: toBase64(bytes), signature: input.signature });
  let res: SafeResponse;
  try {
    res = await deps.get(String(row.resource), { headers: { [header.name]: header.value }, timeoutMs: 60_000 });
  } catch (error) {
    const landed = await deps.chain.read(digest).catch(() => null);
    if (landed) return settle(deps, row, expected, landed, null);
    // Not handed back: the seller may have it. Sending the SAME signed payment
    // again is safe — one digest, on chain at most once.
    return fail(502, 'seller_unreachable', `The seller did not answer (${error instanceof Error ? error.message : 'unknown error'}). Nothing is recorded as paid yet. Pay again — the same signed payment cannot be taken twice.`);
  }

  const settlement = parseSettlement(res.headers.get('payment-response') ?? res.headers.get('x-payment-response'));
  const content = { status: res.status, contentType: res.headers.get('content-type') ?? '', body: res.body.slice(0, 20_000), truncated: res.truncated || res.body.length > 20_000 };

  // Whatever the seller says, the chain decides. Give the facilitator a moment.
  const observed = await waitForTransaction(deps, digest, res.status === 200 ? 8 : 3);
  if (observed) return settle(deps, row, expected, observed, content, settlement?.transaction ?? null);

  if (res.status === 200) {
    // The seller delivered but the chain has not shown the transaction yet.
    // The reservation keeps counting; paying again with the same signature
    // records it once it lands, without paying twice (the digest is fixed).
    return { ok: true as const, status: 'SETTLING' as const, outflowId: row.id, digest, content };
  }
  await closeOutflow(deps.db, {
    orgId: input.orgId,
    id: row.id,
    status: 'FAILED',
    reason: `seller answered ${res.status}${settlement?.errorReason ? `: ${settlement.errorReason}` : ''}`.slice(0, 500),
    txDigest: digest,
  });
  return fail(422, 'seller_refused', `The seller did not accept the payment (${res.status}${settlement?.errorReason ? `: ${settlement.errorReason}` : ''}). Nothing reached the chain.`, { content });
}

async function waitForTransaction(deps: X402Deps, digest: string, tries: number) {
  const sleep = deps.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  for (let i = 0; i < tries; i += 1) {
    const found = await deps.chain.read(digest).catch(() => null);
    if (found) return found;
    if (i < tries - 1) await sleep(1000);
  }
  return null;
}

type Row = Awaited<ReturnType<typeof readOutflow>>;
type Content = { status: number; contentType: string; body: string; truncated: boolean } | null;

async function settle(
  deps: X402Deps,
  row: NonNullable<Row>,
  expected: ExpectedTransfer,
  observed: Awaited<ReturnType<X402Deps['chain']['read']>> & object,
  content: Content,
  sellerDigest: string | null = null,
) {
  const verdict = verifyStablecoinTransfer(expected, observed);
  if (verdict.ok) {
    const auditHash = outflowAuditHash({
      id: row.id,
      orgId: row.orgId,
      kind: row.kind,
      network: row.network,
      coinType: row.coinType,
      principalMinor: BigInt(row.principalMinor),
      feeMinor: BigInt(row.feeMinor),
      senderAddress: row.senderAddress,
      recipientAddress: row.recipientAddress,
      feeAddress: row.feeAddress,
      txDigest: observed.digest,
    });
    await confirmOutflow(deps.db, { orgId: row.orgId, id: row.id, txDigest: observed.digest, auditHash, nowMs: deps.now?.() });
    const fresh = await readOutflow(deps.db, row.orgId, row.id);
    return {
      ...confirmedView(fresh ?? row, content),
      sellerReportedDigest: sellerDigest,
      sellerDigestMatches: sellerDigest === null ? null : sellerDigest === observed.digest,
    };
  }
  await closeOutflow(deps.db, {
    orgId: row.orgId,
    id: row.id,
    status: observed.success ? 'MISMATCH' : 'FAILED',
    reason: verdict.reason,
    txDigest: observed.digest,
  });
  return fail(observed.success ? 409 : 422, observed.success ? 'executed_mismatch' : 'failed_on_chain', verdict.reason, { content });
}

function confirmedView(row: NonNullable<Row>, content: Content) {
  return {
    ok: true as const,
    status: 'CONFIRMED' as const,
    outflowId: row.id,
    txDigest: row.txDigest ?? null,
    explorerUrl: row.txDigest ? explorerTxUrl(STABLECOIN_NETWORK, row.txDigest) : null,
    amountMinor: String(row.principalMinor),
    auditHash: row.auditHash ?? null,
    anchorStatus: row.anchorStatus ?? null,
    content,
  };
}
