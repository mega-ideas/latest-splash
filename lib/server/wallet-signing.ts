/**
 * Signature collection for the Business Splash Wallet (v2 §4.1).
 *
 * A request is one transaction that must be signed by a wallet (a multisig of
 * the owners' passkeys), by the founder alone (the nomination), or by one
 * member (that member's own migration transfer). The lifecycle:
 *
 *   open     The server builds the exact bytes (lib/server/sui-v2-builders.ts),
 *            decodes them (lib/wallet/wallet-tx-describe.ts), checks they are
 *            the shape the purpose allows, that the sponsor will pay for them,
 *            and that they SIMULATE, and only then stores them with their
 *            digest and asks each signer (WhatsApp and the in-app inbox,
 *            lib/server/approval-requests.ts). Nothing is signed before the
 *            simulation passes.
 *   sign     Each signer fetches the request, sees what the bytes do (decoded
 *            from the bytes, review item B10), signs those bytes on their own
 *            device, and sends the partial signature with the digest they
 *            saw. The server refuses a digest that is not the request's, a
 *            signer who is not on the request, a second signature from the
 *            same signer, a signature that does not verify over the stored
 *            bytes under that signer's own key, and any request that has
 *            expired or closed.
 *   submit   When the signed weight reaches the threshold, one caller claims
 *            the submission, the partial signatures are combined
 *            (MultiSigPublicKey.combinePartialSignatures) and the result is
 *            verified against the multisig key, the bytes are checked and
 *            simulated again, the sponsor signs as gas owner, and the
 *            transaction is executed. Executed, failed or expired, every
 *            partial signature is cleared in the statement that closes it.
 *
 * Tenant isolation: every read takes the caller's org, and a request from
 * another org reads as absent (404, not 403).
 *
 * Expiry: at most 24 hours, and never past a payment's quote (settle_by_ms).
 * The bytes carry their own on-chain bound too: a ValidDuring window of the
 * epoch they were built in and the next.
 *
 * Nothing here logs a signature, and no error message carries one.
 */
import { isValidTransactionSignature } from '@mysten/sui/verify';
import { fromBase64, normalizeSuiAddress, toBase64 } from '@mysten/sui/utils';
import { publicKeyFromSuiBytes } from '@mysten/sui/verify';
import { randomUUID } from 'node:crypto';

import { multisigFromBase64 } from '@/lib/wallet/business-multisig';
import {
  describeWalletTransaction,
  WalletTxRefused,
  type WalletAction,
  type WalletTxDescription,
  type WalletTxExpectations,
} from '@/lib/wallet/wallet-tx-describe';
import { assertSponsorable, SponsorRefused, type WalletSponsor } from '@/lib/server/wallet-sponsor';
import {
  claimSubmission,
  closeSigningRequest,
  insertSigningRequest,
  listInboxForSigner,
  OpenRequestExists,
  readSigningRequest,
  recordPartialSignature,
  type DrizzleDb,
  type SigningPurpose,
  type StoredRequest,
} from '@/lib/server/wallet-signing-store';

export const MAX_REQUEST_TTL_MS = 24 * 60 * 60 * 1000;
/** A multisig signature's flag. A signer sends their own part, never a whole. */
const MULTISIG_FLAG = 0x03;

export type ChainResult = { digest: string; success: boolean; error?: string | null };
export type BalanceChange = { address: string; coinType: string; amount: string };

export interface WalletChain {
  simulate(bytes: Uint8Array): Promise<{ success: boolean; error?: string | null; balanceChanges?: BalanceChange[] }>;
  execute(bytes: Uint8Array, signatures: string[]): Promise<ChainResult>;
  /** What the chain says about a digest, or null if it has not seen it. */
  read?(digest: string): Promise<ChainResult | null>;
}

export interface SigningNotifier {
  notify(input: { orgId: string; request: StoredRequest; description: WalletTxDescription; userIds: string[]; now: Date }): Promise<{ delivered: string[]; unreachable: string[] }>;
}

export type SigningDeps = {
  db: DrizzleDb;
  chain: WalletChain;
  /** Null when no sponsor is configured: a sponsored request is then refused. */
  sponsor: WalletSponsor | null;
  /** The org's account and the v2 config ids every request is checked against. */
  expect: WalletTxExpectations;
  notifier?: SigningNotifier;
  /** Called after a request executes (the wallet-creation sequence uses it). */
  onExecuted?: (request: StoredRequest) => Promise<void>;
  now?: () => Date;
};

export type SignerSpec =
  | { kind: 'single'; userId: string; publicKey: string }
  | { kind: 'multisig'; multisigPublicKey: string; members: Array<{ userId: string; publicKey: string; weight: number }> };

export type SigningFailure = { ok: false; status: number; code: string; error: string };
const fail = (status: number, code: string, error: string): SigningFailure => ({ ok: false, status, code, error });

/** A member's address from flag || key (base64). */
function addressOf(suiPublicKey: string): string {
  return publicKeyFromSuiBytes(fromBase64(suiPublicKey)).toSuiAddress();
}

/** The steps that collect a sender's own USDC before one plain transfer. */
const FUNDS_GATHERING: ReadonlySet<string> = new Set(['withdraw', 'merge_coins', 'coin_to_balance', 'join_balance']);

function kinds(actions: WalletAction[]): string {
  return actions.map((a) => a.type).join(',');
}

/** The shapes each purpose allows. Anything else is refused before it is stored. */
export function assertPurposeShape(
  purpose: SigningPurpose,
  d: WalletTxDescription,
  context: { members?: string[]; recipient?: string } = {},
): void {
  const shape = kinds(d.actions);
  const bad = (why: string) => {
    throw new WalletTxRefused(`this transaction is not a ${purpose.replace(/_/g, ' ')}: ${why}`, 'wrong_shape');
  };
  switch (purpose) {
    case 'nominate_wallet':
      if (shape !== 'nominate_wallet') bad(shape);
      return;
    case 'register_wallet': {
      if (shape !== 'register_wallet') bad(shape);
      const a = d.actions[0] as Extract<WalletAction, { type: 'register_wallet' }>;
      if (a.wallet !== d.sender) bad('the wallet must register itself');
      if (context.members) {
        const listed = [...a.members.map((m) => m.address)].sort().join();
        if (listed !== [...context.members].sort().join()) bad('the members are not the signers');
      }
      return;
    }
    case 'rotate_wallet':
    case 'confirm_wallet_rotation':
    case 'cancel_wallet_rotation':
      if (shape !== purpose) bad(shape);
      return;
    case 'wallet_membership':
      if (!['add_owner', 'remove_owner', 'set_recovery_party'].includes(shape)) bad(shape);
      return;
    case 'wallet_payment': {
      if (shape === 'withdraw,open_intent,pay_intent,anchor_receipt,delete_intent') {
        const w = d.actions[0] as Extract<WalletAction, { type: 'withdraw' }>;
        const o = d.actions[1] as Extract<WalletAction, { type: 'open_intent' }>;
        const p = d.actions[2] as Extract<WalletAction, { type: 'pay_intent' }>;
        if (BigInt(w.amountMinor) !== BigInt(o.amountMinor) + BigInt(p.maxFeeMinor)) bad('the withdrawal is not the amount plus the maximum fee');
        if (BigInt(p.settleByMs) > BigInt(o.expiresAtMs)) bad('the quote outlives the intent');
        return;
      }
      if (shape === 'withdraw,pay_intent,anchor_receipt') return;
      bad(shape);
      return;
    }
    case 'migration_transfer': {
      const last = d.actions[d.actions.length - 1];
      const gathering = d.actions.slice(0, -1).every((x) => FUNDS_GATHERING.has(x.type));
      if (last.type !== 'send_funds' || !gathering || d.actions.length < 2) bad(shape);
      const s = last as Extract<WalletAction, { type: 'send_funds' }>;
      if (context.recipient && s.recipient !== normalizeSuiAddress(context.recipient)) bad('the transfer is not to the business wallet');
      return;
    }
  }
}

function assertGasless(d: WalletTxDescription) {
  if (d.gas.owner !== d.sender || d.gas.price !== '0' || d.gas.budget !== '0' || !d.gas.fromAddressBalance || d.validity === null) {
    throw new WalletTxRefused('a gasless transfer pays no gas and names no gas coin', 'not_gasless');
  }
  if (!d.actions.every((a) => a.type === 'send_funds' || FUNDS_GATHERING.has(a.type))) {
    throw new WalletTxRefused('only a plain USDC transfer goes gasless', 'not_gasless');
  }
}

/** The view a signer is shown: the bytes and what they do, read from the bytes now. */
export type RequestView = {
  id: string;
  purpose: SigningPurpose;
  status: StoredRequest['status'];
  sender: string;
  transactionBytes: string;
  digest: string;
  bytesHash: string;
  description: WalletTxDescription;
  threshold: number;
  signedWeight: number;
  expiresAt: string;
  gasMode: 'sponsored' | 'gasless';
  signers: Array<{ userId: string; address: string; weight: number; signed: boolean }>;
  you: { mustSign: boolean; signed: boolean };
  executedDigest: string | null;
  /** What the dry run of these exact bytes moved, when the request opened. */
  simulatedBalanceChanges: BalanceChange[];
};

function signedWeight(request: StoredRequest): number {
  return request.signers.filter((s) => s.signedAt !== null).reduce((a, s) => a + s.weight, 0);
}

function viewOf(request: StoredRequest, description: WalletTxDescription, userId: string): RequestView {
  const me = request.signers.find((s) => s.userId === userId);
  return {
    id: request.id,
    purpose: request.purpose,
    status: request.status,
    sender: request.senderAddress,
    transactionBytes: request.txBytes,
    digest: request.txDigest,
    bytesHash: request.bytesHash,
    description,
    threshold: request.threshold,
    signedWeight: signedWeight(request),
    expiresAt: request.expiresAt.toISOString(),
    gasMode: request.gasMode,
    signers: request.signers.map((s) => ({ userId: s.userId, address: s.address, weight: s.weight, signed: s.signedAt !== null })),
    you: { mustSign: Boolean(me && me.signedAt === null && request.status === 'collecting'), signed: Boolean(me?.signedAt) },
    executedDigest: request.executedDigest,
    simulatedBalanceChanges: ((request.summary as { simulatedBalanceChanges?: BalanceChange[] } | null)?.simulatedBalanceChanges ?? []).map((c) => ({
      address: String(c.address),
      coinType: String(c.coinType),
      amount: String(c.amount),
    })),
  };
}

/**
 * Open a request. Every check runs on the bytes before anything is stored,
 * and the bytes must simulate.
 */
export async function openSigningRequest(
  deps: SigningDeps,
  input: {
    orgId: string;
    requestedBy: string;
    purpose: SigningPurpose;
    dedupeKey: string;
    transactionBytes: Uint8Array;
    signer: SignerSpec;
    gasMode: 'sponsored' | 'gasless';
    ttlMs?: number;
    /** For a migration transfer: the business wallet it must pay. */
    recipient?: string;
    /** Opened by `onExecuted` once this request executes. Keys and weights only. */
    nextStep?: unknown;
  },
): Promise<{ ok: true; request: RequestView } | SigningFailure> {
  const now = (deps.now ?? (() => new Date()))();

  let sender: string;
  let threshold: number;
  let signers: Array<{ userId: string; address: string; publicKey: string; weight: number }>;
  try {
    if (input.signer.kind === 'single') {
      const address = addressOf(input.signer.publicKey);
      sender = address;
      threshold = 1;
      signers = [{ userId: input.signer.userId, address, publicKey: input.signer.publicKey, weight: 1 }];
    } else {
      const ms = multisigFromBase64(input.signer.multisigPublicKey);
      sender = normalizeSuiAddress(ms.toSuiAddress());
      threshold = ms.getThreshold();
      const keyed = ms.getPublicKeys().map((p) => ({ raw: toBase64(p.publicKey.toSuiBytes()), weight: p.weight }));
      signers = input.signer.members.map((m) => ({ userId: m.userId, address: addressOf(m.publicKey), publicKey: m.publicKey, weight: m.weight }));
      const listed = signers.map((s) => `${s.publicKey}:${s.weight}`).sort().join();
      if (listed !== keyed.map((k) => `${k.raw}:${k.weight}`).sort().join() || new Set(signers.map((s) => s.userId)).size !== signers.length) {
        return fail(400, 'members_mismatch', 'the signers named are not exactly the members of the wallet');
      }
    }
  } catch {
    return fail(400, 'bad_signer', 'a signer key could not be read');
  }

  let description: WalletTxDescription;
  try {
    description = describeWalletTransaction(input.transactionBytes, deps.expect);
    if (description.sender !== normalizeSuiAddress(sender)) return fail(400, 'wrong_sender', 'the transaction is not sent by the signer this request names');
    assertPurposeShape(input.purpose, description, { members: signers.map((s) => s.address), recipient: input.recipient });
    if (input.gasMode === 'sponsored') {
      if (!deps.sponsor) return fail(503, 'no_sponsor', 'business wallet transactions need a gas sponsor, and none is configured');
      assertSponsorable(description, { sponsor: deps.sponsor.address, senders: [sender] });
    } else {
      assertGasless(description);
    }
  } catch (error) {
    if (error instanceof WalletTxRefused || error instanceof SponsorRefused) return fail(400, error.code, error.message);
    throw error;
  }

  const simulated = await deps.chain.simulate(input.transactionBytes);
  if (!simulated.success) {
    return fail(422, 'simulation_failed', `the transaction would fail on chain, so nobody is asked to sign it: ${simulated.error ?? 'the dry run failed'}`);
  }

  let ttl = Math.min(input.ttlMs ?? MAX_REQUEST_TTL_MS, MAX_REQUEST_TTL_MS);
  const pay = description.actions.find((a) => a.type === 'pay_intent');
  if (pay && pay.type === 'pay_intent') ttl = Math.min(ttl, Number(BigInt(pay.settleByMs) - BigInt(now.getTime())));
  if (ttl <= 0) return fail(422, 'quote_expired', 'the quote behind this payment has already expired');

  const request = {
    id: `wsr_${randomUUID()}`,
    orgId: input.orgId,
    purpose: input.purpose,
    dedupeKey: input.dedupeKey,
    senderAddress: normalizeSuiAddress(sender),
    signerKind: input.signer.kind,
    multisigPublicKey: input.signer.kind === 'multisig' ? input.signer.multisigPublicKey : null,
    threshold,
    gasMode: input.gasMode,
    txBytes: toBase64(input.transactionBytes),
    txDigest: description.digest,
    bytesHash: description.bytesHash,
    summary: { description, simulatedBalanceChanges: simulated.balanceChanges ?? [] },
    nextStep: input.nextStep ?? null,
    requestedBy: input.requestedBy,
    expiresAt: new Date(now.getTime() + ttl),
  } as const;

  try {
    await insertSigningRequest(deps.db, request, signers);
  } catch (error) {
    if (error instanceof OpenRequestExists) return fail(409, 'request_open', error.message);
    throw error;
  }

  const stored = await readSigningRequest(deps.db, input.orgId, request.id);
  if (!stored) throw new Error('the request was not stored');
  if (deps.notifier) {
    try {
      await deps.notifier.notify({ orgId: input.orgId, request: stored, description, userIds: signers.map((s) => s.userId), now });
    } catch {
      // A notification that did not go out does not undo the request: it is
      // in every signer's inbox in the app.
    }
  }
  return { ok: true, request: viewOf(stored, description, input.requestedBy) };
}

/** Requests waiting on this person's signature, in this org. */
export async function signingInbox(deps: Pick<SigningDeps, 'db' | 'expect' | 'now'>, input: { orgId: string; userId: string }): Promise<RequestView[]> {
  const now = (deps.now ?? (() => new Date()))();
  const rows = await listInboxForSigner(deps.db, input.orgId, input.userId, now);
  return rows.map((r) => viewOf(r, describeWalletTransaction(r.txBytes, deps.expect), input.userId));
}

/** One request, for a signer or the person who asked. Another org's reads as absent. */
export async function readRequestForSigner(
  deps: Pick<SigningDeps, 'db' | 'expect'>,
  input: { orgId: string; userId: string; id: string },
): Promise<{ ok: true; request: RequestView } | SigningFailure> {
  const request = await readSigningRequest(deps.db, input.orgId, input.id);
  if (!request) return fail(404, 'not_found', 'no such request');
  if (!request.signers.some((s) => s.userId === input.userId) && request.requestedBy !== input.userId) {
    return fail(404, 'not_found', 'no such request');
  }
  // Decoded again from the stored bytes, so the view can never drift from them.
  return { ok: true, request: viewOf(request, describeWalletTransaction(request.txBytes, deps.expect), input.userId) };
}

/**
 * One signer's partial signature. When the signed weight reaches the
 * threshold, the request is combined, simulated, sponsored and submitted.
 */
export async function submitPartialSignature(
  deps: SigningDeps,
  input: { orgId: string; userId: string; id: string; signature: string; digest: string },
): Promise<{ ok: true; request: RequestView } | SigningFailure> {
  const now = (deps.now ?? (() => new Date()))();
  const request = await readSigningRequest(deps.db, input.orgId, input.id);
  if (!request) return fail(404, 'not_found', 'no such request');
  const signer = request.signers.find((s) => s.userId === input.userId);
  if (!signer) return fail(403, 'not_a_signer', 'you are not a signer of this request');

  if (request.status !== 'collecting') return fail(409, 'closed', `this request is ${request.status}`);
  if (request.expiresAt.getTime() <= now.getTime()) {
    await closeSigningRequest(deps.db, { orgId: input.orgId, id: request.id, status: 'expired', from: ['collecting'], now });
    return fail(410, 'expired', 'this request has expired; nothing was signed for it');
  }
  if (String(input.digest ?? '') !== request.txDigest) {
    return fail(409, 'digest_mismatch', 'the transaction you reviewed is not the one waiting for signatures; reload it and review again');
  }
  if (signer.signedAt) return fail(409, 'already_signed', 'you have already signed this request');

  const bytes = fromBase64(request.txBytes);
  let valid = false;
  try {
    const raw = fromBase64(String(input.signature ?? ''));
    valid = raw.length > 0 && raw[0] !== MULTISIG_FLAG && (await isValidTransactionSignature(bytes, input.signature, { address: signer.address }));
  } catch {
    valid = false;
  }
  if (!valid) return fail(400, 'bad_signature', 'that signature is not your key signing this transaction');

  const recorded = await recordPartialSignature(deps.db, { orgId: input.orgId, requestId: request.id, userId: input.userId, signature: input.signature, now });
  if (!recorded) return fail(409, 'already_signed', 'this signature was not accepted: the request changed, or you have already signed');

  const updated = (await readSigningRequest(deps.db, input.orgId, request.id)) as StoredRequest;
  if (signedWeight(updated) >= updated.threshold) {
    await submitWhenReady(deps, updated, now);
  }
  const final = (await readSigningRequest(deps.db, input.orgId, request.id)) as StoredRequest;
  return { ok: true, request: viewOf(final, describeWalletTransaction(final.txBytes, deps.expect), input.userId) };
}

async function submitWhenReady(deps: SigningDeps, request: StoredRequest, now: Date): Promise<void> {
  if (!(await claimSubmission(deps.db, request.orgId, request.id, now))) return;
  const close = (status: 'executed' | 'failed', extra: { executedDigest?: string | null; error?: string | null }) =>
    closeSigningRequest(deps.db, { orgId: request.orgId, id: request.id, status, from: ['submitting'], now, ...extra });

  const bytes = fromBase64(request.txBytes);
  const signed = request.signers.filter((s) => s.signature);

  let walletSignature: string;
  try {
    if (request.signerKind === 'single') {
      walletSignature = signed[0].signature as string;
    } else {
      const ms = multisigFromBase64(request.multisigPublicKey as string);
      // A multisig lists its signatures in member order (the bitmap's), and
      // the SDK does not reorder them: sort by each signer's place in the key.
      const order = ms.getPublicKeys().map((p) => toBase64(p.publicKey.toSuiBytes()));
      const partials = [...signed]
        .sort((a, b) => order.indexOf(a.publicKey) - order.indexOf(b.publicKey))
        .map((s) => s.signature as string);
      walletSignature = ms.combinePartialSignatures(partials);
      if (!(await ms.verifyTransaction(bytes, walletSignature))) throw new Error('combined signature does not verify');
    }
  } catch {
    await close('failed', { error: 'the signatures could not be combined into a valid wallet signature' });
    return;
  }

  const signatures = [walletSignature];
  try {
    const description = describeWalletTransaction(bytes, deps.expect);
    if (request.gasMode === 'sponsored') {
      if (!deps.sponsor) throw new SponsorRefused('no gas sponsor is configured', 'no_sponsor');
      assertSponsorable(description, { sponsor: deps.sponsor.address, senders: [request.senderAddress] });
    }
    const simulated = await deps.chain.simulate(bytes);
    if (!simulated.success) {
      await close('failed', { error: `the transaction would fail on chain now: ${simulated.error ?? 'the dry run failed'}` });
      return;
    }
    if (request.gasMode === 'sponsored') signatures.push(await (deps.sponsor as WalletSponsor).sign(bytes));
  } catch (error) {
    await close('failed', { error: error instanceof Error ? error.message : 'the transaction could not be prepared' });
    return;
  }

  let result: ChainResult | null;
  try {
    result = await deps.chain.execute(bytes, signatures);
  } catch {
    // Timeout ambiguity: ask the chain what happened to this digest.
    result = deps.chain.read ? await deps.chain.read(request.txDigest).catch(() => null) : null;
    if (!result) {
      await close('failed', { executedDigest: request.txDigest, error: 'the network did not confirm the submission; check the digest before trying again' });
      return;
    }
  }
  if (result.success) {
    await close('executed', { executedDigest: result.digest });
    const executed = await readSigningRequest(deps.db, request.orgId, request.id);
    if (executed && deps.onExecuted) await deps.onExecuted(executed).catch(() => undefined);
  } else {
    await close('failed', { executedDigest: result.digest || null, error: result.error ?? 'execution failed' });
  }
}

/** The requester (or any signer) withdraws a request nobody needs any more. */
export async function cancelSigningRequest(
  deps: Pick<SigningDeps, 'db' | 'now'>,
  input: { orgId: string; userId: string; id: string },
): Promise<{ ok: true } | SigningFailure> {
  const now = (deps.now ?? (() => new Date()))();
  const request = await readSigningRequest(deps.db, input.orgId, input.id);
  if (!request || (!request.signers.some((s) => s.userId === input.userId) && request.requestedBy !== input.userId)) {
    return fail(404, 'not_found', 'no such request');
  }
  const closed = await closeSigningRequest(deps.db, { orgId: input.orgId, id: input.id, status: 'cancelled', from: ['collecting'], now });
  return closed ? { ok: true } : fail(409, 'closed', `this request is ${request.status}`);
}
