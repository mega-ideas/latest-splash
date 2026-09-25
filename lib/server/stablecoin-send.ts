import { fromBase64, normalizeStructTag, toBase64 } from '@mysten/sui/utils';

import type { UserRole } from '@/lib/agent/types';
import {
  anchorFeeEnabled,
  explorerTxUrl,
  gaslessEligible,
  gaslessEnabled,
  type GasMode,
  normaliseSuiAddress,
  parseUsdcMinor,
  quoteStablecoinTransfer,
  STABLECOIN_NETWORK,
  StablecoinLaneError,
  suiChain,
  SUI_USDC_COIN_TYPE,
} from '@/lib/payments/stablecoin-lane';
import { outflowAuditHash, verifyStablecoinTransfer, type ExpectedTransfer } from '@/lib/payments/stablecoin-verify';
import type { RecipientRecord } from '@/lib/server/operations';
import {
  bindOutflowDigest,
  closeOutflow,
  confirmOutflow,
  readOutflow,
  releaseUnsentQuote,
  reserveOutflow,
} from '@/lib/server/stablecoin-outflows';
import { walletSendable } from '@/lib/server/wallet-screening';
import { stablecoinTransferSubject } from '@/lib/server/step-up-subjects';

/**
 * A wallet transfer, end to end: quote → the business signs → submit.
 *
 *   quote   validate everything, RESERVE the allowance, then build the exact
 *           transaction from the sender's own USDC — gasless where Sui takes
 *           it, so the wallet needs no SUI. Nothing is signed yet.
 *   submit  take the signed bytes, dry-run them, and only if they do exactly
 *           what was quoted, put them on chain. Then read back what happened
 *           and record THAT: CONFIRMED with its audit hash, or FAILED, or
 *           MISMATCH with the digest so an operator can see what was signed.
 *
 * Dependencies are injected so the whole sequence runs in tests against
 * PGlite and a scripted chain.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any;

type Observed = Awaited<ReturnType<ChainDeps['simulate']>>;

export interface ChainDeps {
  /** `gas` is always stated: a caller that forgot it must not get a mode by default. */
  build(input: { sender: string; coinType: string; legs: Array<{ address: string; amountMinor: bigint }>; gas: GasMode }): Promise<Uint8Array>;
  simulate(bytes: Uint8Array): Promise<{ digest: string; success: boolean; error?: string | null; sender: string | null; balanceChanges: Array<{ coinType: string; address: string; amount: string }> }>;
  execute(bytes: Uint8Array, signature: string): Promise<Observed>;
  read(digest: string): Promise<Observed | null>;
  digestOf(bytes: Uint8Array): string;
  senderOf(bytes: Uint8Array): string | null;
  describeBuildError(error: unknown): string;
  /** A gasless refusal the sender can fix (say, change under 0.01 USDC), or null. */
  explainGaslessRefusal?(error: unknown): string | null;
  /** The node did not answer (rate limit, overload), rather than refusing. */
  isTransient?(error: unknown): boolean;
}

/** The approval a transfer must carry before it may reach the chain
 *  (lib/server/step-up.ts): WhatsApp code + passkey, or a click, per Settings. */
export interface ApprovalDeps {
  consume(input: { orgId: string; subjectId: string; subject: unknown }): Promise<boolean>;
  release(input: { orgId: string; subjectId: string }): Promise<void>;
}

export interface SendDeps {
  db: Db;
  chain: ChainDeps;
  approval: ApprovalDeps;
  readRecipient(orgId: string, recipientId: string): Promise<RecipientRecord | null>;
  feeAddress(): string | undefined;
  /** Is this address a Splash user's wallet? Transfers to one are always free. */
  isSplashWallet(address: string): Promise<boolean>;
  /** The audit-anchor fee on transfers out of Splash; off unless switched on. */
  anchorFeeOn?: () => boolean;
  /** Gasless wallet transfers; on unless STABLECOIN_GASLESS=off. */
  gaslessOn?: () => boolean;
  now?: () => number;
}

export type SendFailure = { ok: false; status: number; error: string; code: string; allowance?: unknown };

/** Who may start a wallet transfer. The wallet signature is the payment's
 *  authority; this is who may ask Splash to prepare one. */
const SENDER_ROLES: ReadonlySet<UserRole> = new Set(['OWNER', 'FINANCE_ADMIN', 'MAKER']);

function fail(status: number, code: string, error: string, allowance?: unknown): SendFailure {
  return { ok: false, status, code, error, ...(allowance ? { allowance } : {}) };
}

function allowanceView(a: { usedMinor: bigint; remainingMinor: bigint; windowCapMinor: bigint } | null | undefined) {
  if (!a) return undefined;
  return { usedMinor: a.usedMinor.toString(), remainingMinor: a.remainingMinor.toString(), windowCapMinor: a.windowCapMinor.toString() };
}

// ─── Quote ──────────────────────────────────────────────────────────────────

export async function quoteWalletTransfer(
  deps: SendDeps,
  input: {
    orgId: string;
    userId: string;
    role: UserRole;
    recipientId: string;
    amount: string;
    senderAddress: string;
    /** The sender asked for the wallet to pay gas in SUI: a coin transfer, never gasless. */
    payGasInSui?: boolean;
    /** An earlier quote of theirs this one replaces: released first if it never left Splash. */
    replaces?: string;
  },
) {
  if (!SENDER_ROLES.has(input.role)) {
    return fail(403, 'role_cannot_send', 'Your role can view payments but not start one. Ask an owner, finance admin or maker.');
  }

  let principalMinor: bigint;
  let sender: string;
  try {
    principalMinor = parseUsdcMinor(String(input.amount ?? '').trim());
    sender = normaliseSuiAddress(String(input.senderAddress ?? ''));
  } catch (error) {
    if (error instanceof StablecoinLaneError || error instanceof Error) return fail(400, 'invalid_input', error.message);
    throw error;
  }

  const recipient = await deps.readRecipient(input.orgId, input.recipientId);
  if (!recipient) return fail(404, 'recipient_not_found', 'Recipient not found. Save them under Recipients first.');
  if (recipient.payoutMethod !== 'WALLET' || !recipient.walletAddress) {
    return fail(400, 'not_a_wallet_recipient', 'This recipient is paid to a bank account, not a wallet. Wallet transfers go to wallet recipients only.');
  }

  const network = STABLECOIN_NETWORK;
  const sendable = walletSendable(recipient.screeningVerdict);
  if (!sendable.ok) return fail(403, 'recipient_not_sendable', sendable.reason);

  const recipientAddress = normaliseSuiAddress(recipient.walletAddress);
  if (recipientAddress === sender) return fail(400, 'self_transfer', 'The recipient wallet is the wallet you are sending from.');

  // Free to a Splash user's wallet; to anywhere else, the audit-anchor fee
  // when it is switched on (free until then). lib/payments/stablecoin-lane.ts.
  const destination = (await deps.isSplashWallet(recipientAddress)) ? 'SPLASH' as const : 'EXTERNAL' as const;
  let quote;
  try {
    quote = quoteStablecoinTransfer(principalMinor, { destination, anchorFeeOn: deps.anchorFeeOn?.() ?? anchorFeeEnabled() });
  } catch (error) {
    if (error instanceof StablecoinLaneError) return fail(400, 'below_minimum', `Amount refused: ${error.message}.`);
    throw error;
  }

  // A fee needs a real, named destination — never defaulted. No fee, no leg.
  let feeAddress: string | null = null;
  if (quote.feeMinor > 0n) {
    const configuredFee = deps.feeAddress();
    if (!configuredFee) {
      return fail(503, 'fee_address_missing', 'Transfers out of Splash are not open yet: Splash’s mainnet fee address is not configured.');
    }
    feeAddress = normaliseSuiAddress(configuredFee);
    if (feeAddress === recipientAddress || feeAddress === sender) {
      return fail(400, 'fee_address_conflict', 'This recipient or sender is Splash’s own fee address. That is not a payment Splash will quote.');
    }
  }

  // A re-quote (say, with gas paid in SUI after a wallet would not sign the
  // gasless one) gives back the allowance the first quote held — but never a
  // quote already signed and sent, which may still land.
  if (input.replaces) {
    const released = await releaseUnsentQuote(deps.db, { orgId: input.orgId, id: input.replaces, requestedBy: input.userId, reason: 'replaced by a new quote' });
    if (!released) {
      const earlier = await readOutflow(deps.db, input.orgId, input.replaces);
      if (earlier?.status === 'PENDING' && earlier.txDigest) {
        return fail(409, 'quote_already_sent', 'The earlier quote was already signed and sent. Wait for it to settle before quoting again.');
      }
    }
  }

  const coinType = SUI_USDC_COIN_TYPE[network];
  const nowMs = deps.now?.() ?? Date.now();
  const reserved = await reserveOutflow(deps.db, {
    orgId: input.orgId,
    kind: 'TRANSFER',
    supplierId: recipient.id,
    coinType,
    principalMinor: quote.principalMinor,
    feeMinor: quote.feeMinor,
    senderAddress: sender,
    recipientAddress,
    feeAddress,
    requestedBy: input.userId,
    nowMs,
  });
  if (!reserved.ok) return fail(409, 'allowance', reserved.reason, allowanceView(reserved.allowance));

  const legs = [
    { address: recipientAddress, amountMinor: quote.principalMinor },
    ...(feeAddress ? [{ address: feeAddress, amountMinor: quote.feeMinor }] : []),
  ];
  // Gasless when Sui will take it: the sending wallet then needs no SUI. When
  // the network will not (a protocol change, a leg under its floor, the switch
  // off), or the sender asked to pay gas in SUI, the same transfer with the
  // wallet paying gas — and the quote says so.
  let built: { bytes: Uint8Array; gas: GasMode } | null = null;
  let gaslessRefusal: unknown = null;
  if (!input.payGasInSui && (deps.gaslessOn?.() ?? gaslessEnabled()) && gaslessEligible(coinType, legs)) {
    try {
      built = { bytes: await deps.chain.build({ sender, coinType, legs, gas: 'GASLESS' }), gas: 'GASLESS' };
    } catch (error) {
      // A busy node is not a refusal: falling back would make the sender pay
      // gas for a transfer that goes free a moment later.
      if (deps.chain.isTransient?.(error)) {
        await closeOutflow(deps.db, { orgId: input.orgId, id: reserved.id, status: 'FAILED', reason: 'the Sui node was busy' });
        return fail(503, 'chain_busy', 'The Sui network node did not answer just now, so nothing was prepared or reserved. Try again in a moment.');
      }
      gaslessRefusal = error;
      console.warn('[stablecoin] gasless build refused, falling back to sender-paid gas:', error instanceof Error ? error.message : error);
    }
  }
  try {
    built ??= { bytes: await deps.chain.build({ sender, coinType, legs, gas: 'SENDER_PAYS' }), gas: 'SENDER_PAYS' };
  } catch (error) {
    // Release the reservation: nothing was prepared, so nothing may count.
    await closeOutflow(deps.db, { orgId: input.orgId, id: reserved.id, status: 'FAILED', reason: 'could not build' });
    // Neither way worked. If gasless failed for a reason the sender can fix
    // (the amount would leave dust), that is the useful thing to say.
    const fixable = gaslessRefusal ? deps.chain.explainGaslessRefusal?.(gaslessRefusal) ?? null : null;
    return fail(422, 'cannot_build', fixable ?? deps.chain.describeBuildError(error));
  }
  const { bytes, gas } = built;

  return {
    ok: true as const,
    outflowId: reserved.id,
    network,
    chain: suiChain(network),
    coinType,
    recipient: { id: recipient.id, name: recipient.name, address: recipientAddress, screeningVerdict: recipient.screeningVerdict ?? null },
    senderAddress: sender,
    feeAddress,
    destination: quote.destination,
    feeKind: quote.feeKind,
    gas,
    principalMinor: quote.principalMinor.toString(),
    feeMinor: quote.feeMinor.toString(),
    totalDebitMinor: quote.totalDebitMinor.toString(),
    reservedUntil: reserved.reservedUntil.toISOString(),
    allowance: allowanceView(reserved.allowance),
    transactionBytes: toBase64(bytes),
    expectedDigest: deps.chain.digestOf(bytes),
  };
}

// ─── Submit ─────────────────────────────────────────────────────────────────

export async function submitWalletTransfer(
  deps: SendDeps,
  input: { orgId: string; role: UserRole; outflowId: string; transactionBytes: string; signature: string },
) {
  if (!SENDER_ROLES.has(input.role)) {
    return fail(403, 'role_cannot_send', 'Your role can view payments but not start one.');
  }
  const row = await readOutflow(deps.db, input.orgId, input.outflowId);
  if (!row || row.kind !== 'TRANSFER') return fail(404, 'quote_not_found', 'Quote not found.');

  if (row.status === 'CONFIRMED') return confirmedView(row);
  if (row.status !== 'PENDING') {
    return fail(409, 'quote_closed', `This quote is ${row.status.toLowerCase()}. Start a new transfer.`);
  }

  let bytes: Uint8Array;
  try {
    bytes = fromBase64(String(input.transactionBytes ?? ''));
  } catch {
    return fail(400, 'invalid_bytes', 'The signed transaction could not be read.');
  }
  if (bytes.length === 0 || !input.signature) return fail(400, 'invalid_bytes', 'A signed transaction and its signature are required.');

  const signedSender = safe(() => deps.chain.senderOf(bytes));
  if (!signedSender || normaliseSuiAddress(signedSender) !== normaliseSuiAddress(row.senderAddress)) {
    return fail(400, 'wrong_sender', 'This transaction was prepared for a different wallet than the one that signed it. Connect the quoted wallet, or start again.');
  }

  const expected: ExpectedTransfer = {
    sender: row.senderAddress,
    coinType: row.coinType,
    legs: [
      { address: row.recipientAddress, amountMinor: BigInt(row.principalMinor) },
      ...(row.feeAddress && BigInt(row.feeMinor) > 0n ? [{ address: row.feeAddress, amountMinor: BigInt(row.feeMinor) }] : []),
    ],
  };
  const digest = deps.chain.digestOf(bytes);

  // One signed transaction per quote. If another was already submitted, it is
  // the only one that may settle this quote.
  if (row.txDigest && row.txDigest !== digest) {
    const first = await deps.chain.read(row.txDigest);
    if (first) return settle(deps, row, expected, first);
    return fail(409, 'already_submitted', 'A signed transaction for this quote was already submitted and may still land. Wait for it, or start a new transfer once this quote expires.');
  }

  // A retry after a lost response: if the chain already has it, record what
  // it did rather than submitting twice. Checked BEFORE expiry, because a
  // payment that happened is recorded whether or not its quote has lapsed.
  const already = await deps.chain.read(digest);
  if (already) return settle(deps, row, expected, already);

  const nowMs = deps.now?.() ?? Date.now();
  if (new Date(row.reservedUntil).getTime() <= nowMs) {
    await closeOutflow(deps.db, { orgId: input.orgId, id: row.id, status: 'EXPIRED', reason: 'quote lapsed before submission' });
    return fail(410, 'quote_expired', 'This quote expired before it was sent. Nothing moved. Start a new transfer.');
  }

  // The approval — WhatsApp code + passkey, or a click, per Settings — for
  // exactly this quote. Spent here, before the chain; handed back below if
  // nothing moves, so a retry does not need a second approval.
  const approvalSubject = stablecoinTransferSubject(row, '');
  // (x402 rows are paid through lib/server/x402-pay.ts, never here.)
  // A resend of the SAME bound transaction already spent its approval.
  const resend = row.txDigest === digest;
  const approved = resend || await deps.approval.consume({ orgId: input.orgId, subjectId: row.id, subject: approvalSubject.subject });
  if (!approved) {
    return fail(428, 'approval_required', 'This transfer has not been approved yet. Approve it first — by WhatsApp code and passkey, or by clicking Approve, depending on your Settings — then sign.');
  }
  const handBack = () => deps.approval.release({ orgId: input.orgId, subjectId: row.id });

  // The dry run: what these exact signed bytes would do, with nothing moved.
  // A node that refuses them outright (Sui's gasless rules, checked again
  // against the wallet as it is now) or does not answer has moved nothing
  // either: the approval goes back, and the person is told which it was.
  let dry: Observed;
  try {
    dry = await deps.chain.simulate(bytes);
  } catch (error) {
    if (!resend) await handBack();
    if (deps.chain.isTransient?.(error)) {
      return fail(503, 'chain_busy', 'The Sui network node did not answer the check before sending. Nothing was sent. Send again in a moment.');
    }
    const fixable = deps.chain.explainGaslessRefusal?.(error);
    return fail(422, 'preflight_refused', `Not sent — Sui refused the transaction on the check before sending. ${fixable ?? (error instanceof Error ? error.message : String(error))}`);
  }
  const preflight = verifyStablecoinTransfer(expected, dry);
  if (!preflight.ok) {
    if (!resend) await handBack();
    return fail(409, 'preflight_mismatch', `Not sent — the signed transaction does not match the quote. ${preflight.reason}`);
  }

  // From here the transaction leaves Splash: bind the quote to it.
  if (!(await bindOutflowDigest(deps.db, { orgId: input.orgId, id: row.id, txDigest: digest }))) {
    return fail(409, 'already_submitted', 'Another transaction was submitted for this quote first. Refresh to see where it stands.');
  }

  let executed: Observed;
  try {
    executed = await deps.chain.execute(bytes, input.signature);
  } catch (error) {
    // The submission may have landed even though the answer was lost.
    const landed = await deps.chain.read(digest).catch(() => null);
    if (landed) return settle(deps, row, expected, landed);
    // Not handed back: the transaction may still land. Sending the SAME
    // signed transaction again is safe (one digest, executed at most once).
    return fail(502, 'submit_unconfirmed', `The network did not confirm the submission (${error instanceof Error ? error.message : 'unknown error'}). Nothing is recorded as sent yet. Send again — the same signed transaction cannot be paid twice.`);
  }
  return settle(deps, row, expected, executed);
}

async function settle(deps: SendDeps, row: Record<string, unknown> & OutflowRow, expected: ExpectedTransfer, observed: Observed) {
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
    return confirmedView(fresh ?? row);
  }
  if (!observed.success) {
    await closeOutflow(deps.db, { orgId: row.orgId, id: row.id, status: 'FAILED', reason: verdict.reason, txDigest: observed.digest });
    // Read from the chain, not the quote: a gasless transfer that failed cost
    // nothing, one that paid gas was still charged for it.
    const charged = gasCharged(observed, row.senderAddress);
    return fail(422, 'failed_on_chain', `${verdict.reason} Your USDC did not move${charged ? '; the network fee (gas) was still charged' : ', and no network fee was charged'}.`);
  }
  await closeOutflow(deps.db, { orgId: row.orgId, id: row.id, status: 'MISMATCH', reason: verdict.reason, txDigest: observed.digest });
  return fail(409, 'executed_mismatch', `The transaction went through but did not match the quote, so Splash has not recorded it as this payment. ${verdict.reason}`);
}

const SUI_COIN = normalizeStructTag('0x2::sui::SUI');

/** Did the sender's SUI go down? That is the gas a transaction was charged. */
function gasCharged(observed: Observed, sender: string): boolean {
  const who = normaliseSuiAddress(sender);
  return observed.balanceChanges.some((change) => {
    if (normalizeStructTag(change.coinType) !== SUI_COIN) return false;
    try {
      return normaliseSuiAddress(change.address) === who && BigInt(change.amount) < 0n;
    } catch {
      return false;
    }
  });
}

interface OutflowRow {
  id: string;
  orgId: string;
  kind: string;
  network: string;
  coinType: string;
  principalMinor: bigint | string;
  feeMinor: bigint | string;
  senderAddress: string;
  recipientAddress: string;
  feeAddress: string | null;
  txDigest?: string | null;
  auditHash?: string | null;
  anchorStatus?: string;
  confirmedAt?: Date | string | null;
}

function confirmedView(row: OutflowRow) {
  const network = STABLECOIN_NETWORK;
  return {
    ok: true as const,
    status: 'CONFIRMED' as const,
    outflowId: row.id,
    network,
    txDigest: row.txDigest ?? null,
    explorerUrl: row.txDigest ? explorerTxUrl(network, row.txDigest) : null,
    principalMinor: String(row.principalMinor),
    feeMinor: String(row.feeMinor),
    auditHash: row.auditHash ?? null,
    anchorStatus: row.anchorStatus ?? null,
  };
}

function safe<T>(fn: () => T): T | null {
  try {
    return fn();
  } catch {
    return null;
  }
}
