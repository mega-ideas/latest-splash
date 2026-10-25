/**
 * Signature collection for the Business Splash Wallet (v2 §4.1).
 *
 * A request is one transaction that must be signed by a wallet (a multisig of
 * the owners' passkeys), by the founder alone (the nomination), or by one
 * member (that member's own migration transfer). The lifecycle:
 *
 *   open     The server builds the exact bytes (lib/server/sui-v2-builders.ts),
 *            decodes them (lib/wallet/wallet-tx-describe.ts), checks they are
 *            the shape the purpose allows, that the sponsor will pay for them
 *            and the org is inside its daily sponsored-gas budget, and that
 *            they SIMULATE, and only then stores them with their digest and
 *            asks each signer (WhatsApp and the in-app inbox,
 *            lib/server/approval-requests.ts). Nothing is signed before the
 *            simulation passes.
 *   sign     Each signer fetches the request, sees what the bytes do (decoded
 *            from the bytes, review item B10), signs those bytes on their own
 *            device, and sends the partial signature with the digest they
 *            saw. The server refuses a digest that is not the request's, a
 *            signer who is not on the request, a second signature from the
 *            same signer, a signature that does not verify over the stored
 *            bytes under that signer's own key, and any request that has
 *            expired or closed. A signer may instead decline: that is
 *            recorded and the request stays open for the others, unless the
 *            remaining signers can no longer reach the threshold. Only the
 *            person who asked can withdraw a request, so no one signer has a
 *            veto over the quorum.
 *   submit   When the signed weight reaches the threshold, one caller claims
 *            the submission (and the time it did), the partial signatures are
 *            combined (MultiSigPublicKey.combinePartialSignatures) and the
 *            result is verified against the multisig key, the bytes are
 *            checked and simulated again, the sponsor signs as gas owner, and
 *            the transaction is executed.
 *   outcome  Executed or failed on chain, the request closes. If the network
 *            does not answer (a timeout, a crash, a redeploy), the request is
 *            `unknown`: it keeps its digest and its dedupe key, holds no
 *            partial signature, and the cron (`reconcileSigningRequestsForStaff`)
 *            reads the digest until it is final, running the follow-up step
 *            if it executed. Bytes whose ValidDuring window has passed can no
 *            longer land, so an unknown request past it closes as failed.
 *            A request still `submitting` past the lease is treated the same.
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
  type OpenIntentExpectation,
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
  listInFlightForStaff,
  markOutcomeUnknown,
  OpenRequestExists,
  readSigningRequest,
  recordDecline,
  recordPartialSignature,
  sponsoredBudgetSince,
  type DrizzleDb,
  type SigningPurpose,
  type StoredRequest,
} from '@/lib/server/wallet-signing-store';

export const MAX_REQUEST_TTL_MS = 24 * 60 * 60 * 1000;
/** How long a claimed submission may stay `submitting` before the cron asks the chain. */
export const SUBMISSION_LEASE_MS = 5 * 60 * 1000;
/**
 * The most gas, in MIST, the sponsor agrees to pay for one org's wallet
 * requests in any 24 hours: 1 SUI, twenty requests at the per-transaction
 * cap. A registration or a payment uses a small fraction of its cap, so this
 * bounds what one org (or one person in a single-signer org) can drain from
 * the operator's hot balance, not ordinary use.
 */
export const WALLET_SPONSOR_DAILY_BUDGET_MIST = 1_000_000_000n;
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
  /**
   * Checked before each signature is taken: what the bytes commit to must
   * still be what the server holds (a withdrawal's bank account, say). A
   * reason refuses the signature; null lets it through.
   */
  beforeSign?: (request: StoredRequest) => Promise<{ code: string; error: string } | null>;
  now?: () => Date;
  /** Override of WALLET_SPONSOR_DAILY_BUDGET_MIST (tests). */
  sponsorDailyBudgetMist?: bigint;
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

export type ShapeContext = {
  /** The wallet's member addresses (register, nominate). */
  members?: string[];
  /** The address a transfer must pay (migration, rotation transfer). */
  recipient?: string;
  /**
   * Spending rules: addresses whose ownership proof is verified, the only
   * ones a WALLET tag may be given (A1 §2.3; the proof itself is §4.7).
   */
  walletTagAllowed?: string[];
  /** A second approval: the payer it must name. */
  payer?: string;
  /** A withdrawal: the beneficiary commitment (hex) the intent must carry. */
  beneficiaryRef?: string;
  /** A withdrawal or a test deposit: the exact principal (minor units). */
  amountMinor?: bigint;
};

/** What a spending-rule transaction (`spend_rule`) may do, and nothing else. */
const SPEND_RULE_ACTIONS: ReadonlySet<string> = new Set([
  'add_spender',
  'remove_spender',
  'verify_recipient',
  'remove_recipient',
  'verify_beneficiary',
  'remove_beneficiary',
  'set_limits',
  'set_running_window',
  'rate_limit',
  'wrap_rate_limit',
  'propose_allowance',
  'accept_allowance',
  'revoke_allowance',
]);

/** The shapes each purpose allows. Anything else is refused before it is stored. */
export function assertPurposeShape(purpose: SigningPurpose, d: WalletTxDescription, context: ShapeContext = {}): void {
  const shape = kinds(d.actions);
  const bad = (why: string): never => {
    throw new WalletTxRefused(`this transaction is not a ${purpose.replace(/_/g, ' ')}: ${why}`, 'wrong_shape');
  };
  const sameSet = (a: string[], b: string[]) => [...a].sort().join() === [...b].sort().join();
  switch (purpose) {
    case 'nominate_wallet': {
      // The founder first makes every wallet member an on-chain owner (Move's
      // register_wallet refuses a member who is not one), then nominates.
      const last = d.actions[d.actions.length - 1];
      if (last?.type !== 'nominate_wallet') bad(shape);
      const added = d.actions.slice(0, -1);
      if (!added.every((x) => x.type === 'add_owner')) bad(shape);
      if (added.length > 0) {
        if (!context.members) bad('it adds owners, and no wallet members were named');
        const allowed = new Set((context.members ?? []).map((m) => normalizeSuiAddress(m)));
        for (const x of added) if (!allowed.has((x as unknown as { address: string }).address)) bad('it adds an owner who is not a wallet member');
      }
      return;
    }
    case 'register_wallet': {
      if (shape !== 'register_wallet') bad(shape);
      const a = d.actions[0] as Extract<WalletAction, { type: 'register_wallet' }>;
      if (a.wallet !== d.sender) bad('the wallet must register itself');
      if (context.members && !sameSet(a.members.map((m) => m.address), context.members)) bad('the members are not the signers');
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
      if (shape === 'withdraw,pay_intent,anchor_receipt') {
        const w = d.actions[0] as Extract<WalletAction, { type: 'withdraw' }>;
        const p = d.actions[1] as Extract<WalletAction, { type: 'pay_intent' }>;
        // The describer only accepts an existing intent whose fields were read
        // from the chain; the withdrawal must be exactly its principal plus
        // the fee bound the signers see, and the quote cannot outlive it.
        if (!p.intent) bad('the intent paid was not read from the chain');
        const intent = p.intent as OpenIntentExpectation;
        if (BigInt(w.amountMinor) !== BigInt(intent.amountMinor) + BigInt(p.maxFeeMinor)) bad('the withdrawal is not the amount plus the maximum fee');
        if (BigInt(p.settleByMs) > BigInt(intent.expiresAtMs)) bad('the quote outlives the intent');
        return;
      }
      bad(shape);
      return;
    }
    case 'withdrawal': {
      // v2 §4.4: a new bank payout (kind 4) from the wallet to the business's
      // verified partner deposit address, for the business's own bank account
      // (its beneficiary commitment), of exactly the amount the partner was
      // instructed. Nothing else is a withdrawal.
      if (shape !== 'withdraw,open_intent,pay_intent,anchor_receipt,delete_intent') bad(shape);
      const w = d.actions[0] as Extract<WalletAction, { type: 'withdraw' }>;
      const o = d.actions[1] as Extract<WalletAction, { type: 'open_intent' }>;
      const p = d.actions[2] as Extract<WalletAction, { type: 'pay_intent' }>;
      if (BigInt(w.amountMinor) !== BigInt(o.amountMinor) + BigInt(p.maxFeeMinor)) bad('the withdrawal is not the amount plus the maximum fee');
      if (BigInt(p.settleByMs) > BigInt(o.expiresAtMs)) bad('the quote outlives the intent');
      if (o.kind !== 4) bad('it is not a bank payout');
      if (!context.recipient || o.recipient !== normalizeSuiAddress(context.recipient)) bad("it does not pay the business's verified partner deposit address");
      if (!context.beneficiaryRef || o.beneficiaryRef !== context.beneficiaryRef.toLowerCase()) bad("it is not for the business's own bank account");
      if (context.amountMinor === undefined || BigInt(o.amountMinor) !== context.amountMinor) bad('the amount is not the one the partner was told');
      return;
    }
    case 'partner_test_deposit': {
      if (shape !== 'withdraw,send_funds') bad('a test deposit is one withdrawal from the wallet and one transfer');
      const s = d.actions[1] as Extract<WalletAction, { type: 'send_funds' }>;
      if (!context.recipient || s.recipient !== normalizeSuiAddress(context.recipient)) bad("the transfer is not to the business's partner deposit address");
      if (context.amountMinor === undefined || s.amountMinor === null || BigInt(s.amountMinor) !== context.amountMinor) bad('the transfer is not the test amount');
      return;
    }
    case 'spend_policy': {
      if (shape !== 'create_spend_policy') bad(shape);
      const a = d.actions[0] as Extract<WalletAction, { type: 'create_spend_policy' }>;
      if (a.wallet !== d.sender) bad('the policy is created by the wallet whose keys it names');
      return;
    }
    case 'spend_rule': {
      if (!d.actions.every((x) => SPEND_RULE_ACTIONS.has(x.type))) bad(shape);
      const policies = new Set(d.actions.flatMap((x) => ('policy' in x ? [x.policy] : [])));
      if (policies.size > 1) bad('it changes more than one policy');
      const proven = new Set((context.walletTagAllowed ?? []).map((a) => normalizeSuiAddress(a)));
      for (const x of d.actions) {
        // A1 §2.3: the WALLET tag (2 bps) only after the ownership proof.
        if (x.type === 'verify_recipient' && x.kind === 1 && !proven.has(x.address)) bad(`${x.address} is tagged a wallet without a verified ownership proof`);
        if (x.type === 'propose_allowance' && x.rateLimit === null) bad('a rule always has its recurring cap');
        if (x.type === 'propose_allowance' && x.expiresAtMs === null) bad('a rule always has an expiry');
      }
      return;
    }
    case 'spend_approval': {
      if (shape !== 'approve_payout') bad(shape);
      const a = d.actions[0] as Extract<WalletAction, { type: 'approve_payout' }>;
      if (context.payer && a.payer !== normalizeSuiAddress(context.payer)) bad('the approval names another payer');
      if (BigInt(a.maxTotalMinor) < BigInt(a.intent.amountMinor)) bad('the approved total is below the principal');
      if (BigInt(a.settleByMs) > BigInt(a.intent.expiresAtMs)) bad('the approval outlives the payment');
      return;
    }
    case 'migration_transfer':
    case 'rotation_transfer': {
      const last = d.actions[d.actions.length - 1];
      const gathering = d.actions.slice(0, -1).every((x) => FUNDS_GATHERING.has(x.type));
      if (last.type !== 'send_funds' || !gathering || d.actions.length < 2) bad(shape);
      if (purpose === 'rotation_transfer' && shape !== 'withdraw,send_funds') bad('a wallet moves its address balance in one withdrawal');
      const s = last as Extract<WalletAction, { type: 'send_funds' }>;
      if (!context.recipient) bad('no destination wallet was named');
      if (s.recipient !== normalizeSuiAddress(context.recipient as string)) bad('the transfer is not to the business wallet');
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

/** What a request's bytes are decoded against: the org's ids, plus any existing intent read when it opened. */
function expectationsFor(request: StoredRequest, expect: WalletTxExpectations): WalletTxExpectations {
  const summary = request.summary as { openIntent?: OpenIntentExpectation; spend?: WalletTxExpectations['spend'] } | null;
  return {
    ...expect,
    ...(summary?.openIntent ? { openIntent: summary.openIntent } : {}),
    ...(summary?.spend ? { spend: summary.spend } : {}),
  };
}

/** The public ids a device needs to decode a request's bytes itself. */
export type PublicExpectations = WalletTxExpectations;

/** The view a signer is shown: the bytes and what they do, read from the bytes now. */
/**
 * What a withdrawal's signers are shown beside the bytes (v2 §4.4): the bytes
 * carry only a salted commitment to the bank account, so the server binds
 * the account it was built from (bank code, last four digits, holder), the
 * quoted and least receive amounts, the rate and the deadline, and checks
 * them again before each signature (`beforeSign`).
 */
export type WithdrawalSigningDetails = {
  destinationId: string;
  bankCode: string;
  last4: string;
  holderName: string;
  currency: string;
  /** Local minor units the quote said the account receives. */
  receiveMinor: string;
  /** The least the account must receive: what the owners accepted. */
  minReceiveMinor: string;
  rateMicro: string;
  /** The deposit's deadline, ms since epoch (the intent's settle_by). */
  settleByMs: string;
};

export type RequestView = {
  id: string;
  purpose: SigningPurpose;
  status: StoredRequest['status'];
  sender: string;
  transactionBytes: string;
  digest: string;
  bytesHash: string;
  /** Null when the bytes no longer decode against this org's configuration. */
  description: WalletTxDescription | null;
  /** False when the bytes no longer decode: the request cannot be signed. */
  valid: boolean;
  invalidReason: string | null;
  /**
   * What a signer's device decodes the bytes against
   * (lib/wallet/review-on-device.ts): public object ids only. The device
   * renders its own decoding of `transactionBytes`, never `description`.
   */
  expect: PublicExpectations;
  threshold: number;
  signedWeight: number;
  expiresAt: string;
  gasMode: 'sponsored' | 'gasless';
  signers: Array<{ userId: string; address: string; weight: number; signed: boolean; declined: boolean }>;
  you: { mustSign: boolean; signed: boolean; declined: boolean; requested: boolean };
  executedDigest: string | null;
  /** What the dry run of these exact bytes moved, when the request opened. */
  simulatedBalanceChanges: BalanceChange[];
  /** A withdrawal: the bank account and amounts the bytes were built for. */
  withdrawal: WithdrawalSigningDetails | null;
};

function signedWeight(request: StoredRequest): number {
  return request.signers.filter((s) => s.signedAt !== null).reduce((a, s) => a + s.weight, 0);
}

function reachableWeight(request: StoredRequest): number {
  return request.signers.filter((s) => s.declinedAt === null).reduce((a, s) => a + s.weight, 0);
}

function viewOf(request: StoredRequest, expect: WalletTxExpectations, userId: string): RequestView {
  const me = request.signers.find((s) => s.userId === userId);
  const expectations = expectationsFor(request, expect);
  let description: WalletTxDescription | null = null;
  let invalidReason: string | null = null;
  try {
    description = describeWalletTransaction(request.txBytes, expectations);
  } catch (error) {
    // One request that no longer decodes (a configuration id changed) must
    // not take the whole inbox down: it is shown as no longer valid.
    invalidReason = error instanceof WalletTxRefused ? error.message : 'these bytes could not be read';
  }
  const valid = description !== null;
  return {
    id: request.id,
    purpose: request.purpose,
    status: request.status,
    sender: request.senderAddress,
    transactionBytes: request.txBytes,
    digest: request.txDigest,
    bytesHash: request.bytesHash,
    description,
    valid,
    invalidReason,
    expect: expectations,
    threshold: request.threshold,
    signedWeight: signedWeight(request),
    expiresAt: request.expiresAt.toISOString(),
    gasMode: request.gasMode,
    signers: request.signers.map((s) => ({ userId: s.userId, address: s.address, weight: s.weight, signed: s.signedAt !== null, declined: s.declinedAt !== null })),
    you: {
      mustSign: Boolean(valid && me && me.signedAt === null && me.declinedAt === null && request.status === 'collecting'),
      signed: Boolean(me?.signedAt),
      declined: Boolean(me?.declinedAt),
      requested: request.requestedBy === userId,
    },
    executedDigest: request.executedDigest,
    simulatedBalanceChanges: ((request.summary as { simulatedBalanceChanges?: BalanceChange[] } | null)?.simulatedBalanceChanges ?? []).map((c) => ({
      address: String(c.address),
      coinType: String(c.coinType),
      amount: String(c.amount),
    })),
    withdrawal: ((request.summary as { withdrawal?: WithdrawalSigningDetails } | null)?.withdrawal ?? null),
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
    /** For a migration or rotation transfer: the business wallet it must pay. */
    recipient?: string;
    /** For a nomination: the wallet's member addresses it may add as owners. */
    members?: string[];
    /** For paying an existing intent: its fields, as the server read them from the chain. */
    openIntent?: OpenIntentExpectation;
    /** For a spending-rule request: the org's policies, allowances and caps it may touch, read from the chain. */
    spend?: WalletTxExpectations['spend'];
    /** For a spending-rule request: addresses with a verified ownership proof (the WALLET tag). */
    walletTagAllowed?: string[];
    /** For a second approval: the payer it must name. */
    payer?: string;
    /** For a withdrawal: the beneficiary commitment the intent must carry. */
    beneficiaryRef?: string;
    /** For a withdrawal or a test deposit: the exact principal. */
    amountMinor?: bigint;
    /** For a withdrawal: the bank account and amounts its signers are shown. */
    withdrawal?: WithdrawalSigningDetails;
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

  const expectations: WalletTxExpectations = {
    ...deps.expect,
    ...(input.openIntent ? { openIntent: input.openIntent } : {}),
    ...(input.spend ? { spend: input.spend } : {}),
  };
  let description: WalletTxDescription;
  try {
    description = describeWalletTransaction(input.transactionBytes, expectations);
    if (description.sender !== normalizeSuiAddress(sender)) return fail(400, 'wrong_sender', 'the transaction is not sent by the signer this request names');
    const members = input.purpose === 'register_wallet' ? signers.map((s) => s.address) : input.members;
    assertPurposeShape(input.purpose, description, {
      members,
      recipient: input.recipient,
      walletTagAllowed: input.walletTagAllowed,
      payer: input.payer,
      beneficiaryRef: input.beneficiaryRef,
      amountMinor: input.amountMinor,
    });
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

  if (input.gasMode === 'sponsored') {
    const used = await sponsoredBudgetSince(deps.db, input.orgId, new Date(now.getTime() - 24 * 60 * 60 * 1000));
    if (used + BigInt(description.gas.budget) > (deps.sponsorDailyBudgetMist ?? WALLET_SPONSOR_DAILY_BUDGET_MIST)) {
      return fail(429, 'sponsor_budget', 'this business has used its network-fee allowance for the last 24 hours; try again later');
    }
  }

  const simulated = await deps.chain.simulate(input.transactionBytes);
  if (!simulated.success) {
    return fail(422, 'simulation_failed', `the transaction would fail on chain, so nobody is asked to sign it: ${simulated.error ?? 'the dry run failed'}`);
  }

  let ttl = Math.min(input.ttlMs ?? MAX_REQUEST_TTL_MS, MAX_REQUEST_TTL_MS);
  const pay = description.actions.find((a) => a.type === 'pay_intent');
  if (pay && pay.type === 'pay_intent') ttl = Math.min(ttl, Number(BigInt(pay.settleByMs) - BigInt(now.getTime())));
  // A second approval is useless once its settle-by time has passed.
  const approval = description.actions.find((a) => a.type === 'approve_payout');
  if (approval && approval.type === 'approve_payout') ttl = Math.min(ttl, Number(BigInt(approval.settleByMs) - BigInt(now.getTime())));
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
    summary: {
      description,
      simulatedBalanceChanges: simulated.balanceChanges ?? [],
      ...(input.openIntent ? { openIntent: input.openIntent } : {}),
      ...(input.spend ? { spend: input.spend } : {}),
      ...(input.withdrawal ? { withdrawal: input.withdrawal } : {}),
    },
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
  return { ok: true, request: viewOf(stored, deps.expect, input.requestedBy) };
}

/** Requests waiting on this person's signature, in this org. */
export async function signingInbox(deps: Pick<SigningDeps, 'db' | 'expect' | 'now'>, input: { orgId: string; userId: string }): Promise<RequestView[]> {
  const now = (deps.now ?? (() => new Date()))();
  const rows = await listInboxForSigner(deps.db, input.orgId, input.userId, now);
  return rows.map((r) => viewOf(r, deps.expect, input.userId));
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
  return { ok: true, request: viewOf(request, deps.expect, input.userId) };
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
  if (signer.declinedAt) return fail(409, 'declined', 'you declined this request');
  try {
    describeWalletTransaction(request.txBytes, expectationsFor(request, deps.expect));
  } catch {
    return fail(409, 'no_longer_valid', 'this request no longer matches the business account; ask for it again');
  }
  if (deps.beforeSign) {
    const refused = await deps.beforeSign(request);
    if (refused) return fail(409, refused.code, refused.error);
  }

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
  return { ok: true, request: viewOf(final, deps.expect, input.userId) };
}

/** Close an in-flight request on the chain's answer, and run its follow-up once. */
async function settleOutcome(
  deps: Pick<SigningDeps, 'db' | 'onExecuted'>,
  request: StoredRequest,
  result: ChainResult,
  now: Date,
): Promise<'executed' | 'failed' | 'raced'> {
  const status = result.success ? 'executed' : 'failed';
  const closed = await closeSigningRequest(deps.db, {
    orgId: request.orgId,
    id: request.id,
    status,
    from: ['submitting', 'unknown'],
    now,
    executedDigest: result.digest || request.txDigest,
    error: result.success ? null : (result.error ?? 'execution failed'),
  });
  if (!closed) return 'raced';
  if (result.success && deps.onExecuted) {
    const executed = await readSigningRequest(deps.db, request.orgId, request.id);
    if (executed) await deps.onExecuted(executed).catch(() => undefined);
  }
  return status;
}

async function submitWhenReady(deps: SigningDeps, request: StoredRequest, now: Date): Promise<void> {
  if (!(await claimSubmission(deps.db, request.orgId, request.id, now))) return;
  const close = (status: 'failed', extra: { error: string }) =>
    closeSigningRequest(deps.db, { orgId: request.orgId, id: request.id, status, from: ['submitting', 'unknown'], now, ...extra });

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
    const description = describeWalletTransaction(bytes, expectationsFor(request, deps.expect));
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
    // Timeout ambiguity: the bytes may have landed. Ask the chain; if it has
    // not seen them, the outcome is unknown, not failed. The request keeps
    // its digest and dedupe key, and the cron reads the digest until it is
    // final (reconcileSigningRequestsForStaff).
    result = deps.chain.read ? await deps.chain.read(request.txDigest).catch(() => null) : null;
    if (!result) {
      await markOutcomeUnknown(deps.db, {
        orgId: request.orgId,
        id: request.id,
        from: ['submitting'],
        error: 'sent to the network, which has not confirmed it yet; Splash checks the digest until it does',
        now,
      });
      return;
    }
  }
  await settleOutcome(deps, request, result, now);
}

/**
 * The cron's reconcile (cross-tenant, close only): every request still
 * submitting past the lease, and every unknown one, is read on chain by its
 * digest. Executed or failed there, it closes, and an executed one runs its
 * follow-up step (`onExecuted`, with the request's own org). Not seen: a
 * stuck submission becomes unknown (its partial signatures are cleared),
 * and an unknown request whose ValidDuring window has passed closes as
 * failed, because those bytes can never land now. Its dedupe key is released
 * only then.
 */
export async function reconcileSigningRequestsForStaff(deps: {
  db: DrizzleDb;
  chain: { read(digest: string): Promise<ChainResult | null>; currentEpoch(): Promise<bigint> };
  onExecuted?: (request: StoredRequest) => Promise<void>;
  now?: () => Date;
  leaseMs?: number;
}): Promise<{ executed: number; failed: number; unknown: number; errors: number }> {
  const now = (deps.now ?? (() => new Date()))();
  const cutoff = new Date(now.getTime() - (deps.leaseMs ?? SUBMISSION_LEASE_MS));
  const tally = { executed: 0, failed: 0, unknown: 0, errors: 0 };
  let epoch: bigint | null = null;
  for (const request of await listInFlightForStaff(deps.db, cutoff)) {
    let result: ChainResult | null;
    try {
      result = await deps.chain.read(request.txDigest);
    } catch {
      tally.errors += 1;
      continue;
    }
    if (result) {
      const outcome = await settleOutcome(deps, request, result, now);
      if (outcome !== 'raced') tally[outcome] += 1;
      continue;
    }
    if (request.status === 'submitting') {
      await markOutcomeUnknown(deps.db, {
        orgId: request.orgId,
        id: request.id,
        from: ['submitting'],
        error: 'the submission did not finish; Splash checks the digest until the network answers',
        now,
      });
    }
    const maxEpoch = (request.summary as { description?: WalletTxDescription } | null)?.description?.validity?.maxEpoch ?? null;
    try {
      epoch ??= await deps.chain.currentEpoch();
    } catch {
      tally.errors += 1;
      tally.unknown += 1;
      continue;
    }
    if (maxEpoch !== null && epoch > BigInt(maxEpoch)) {
      const closed = await closeSigningRequest(deps.db, {
        orgId: request.orgId,
        id: request.id,
        status: 'failed',
        from: ['unknown'],
        now,
        executedDigest: null,
        error: 'it never reached the chain, and its validity window has passed, so it never will; nothing moved',
      });
      if (closed) tally.failed += 1;
      continue;
    }
    tally.unknown += 1;
  }
  return tally;
}

/**
 * The person who asked withdraws a request nobody needs any more. A signer
 * who did not ask cannot: one key must not veto the quorum (a member being
 * rotated out would block their own removal). They decline instead.
 */
export async function cancelSigningRequest(
  deps: Pick<SigningDeps, 'db' | 'now'>,
  input: { orgId: string; userId: string; id: string },
): Promise<{ ok: true } | SigningFailure> {
  const now = (deps.now ?? (() => new Date()))();
  const request = await readSigningRequest(deps.db, input.orgId, input.id);
  if (!request || (!request.signers.some((s) => s.userId === input.userId) && request.requestedBy !== input.userId)) {
    return fail(404, 'not_found', 'no such request');
  }
  if (request.requestedBy !== input.userId) {
    return fail(403, 'not_requester', 'only the person who asked can withdraw this request; you can decline to sign it');
  }
  const closed = await closeSigningRequest(deps.db, { orgId: input.orgId, id: input.id, status: 'cancelled', from: ['collecting'], now });
  return closed ? { ok: true } : fail(409, 'closed', `this request is ${request.status}`);
}

/**
 * A signer declines to sign. It is recorded and the request stays open for
 * the others; it closes only when the signers who have not declined can no
 * longer reach the threshold.
 */
export async function declineSigningRequest(
  deps: Pick<SigningDeps, 'db' | 'now'>,
  input: { orgId: string; userId: string; id: string },
): Promise<{ ok: true; closed: boolean } | SigningFailure> {
  const now = (deps.now ?? (() => new Date()))();
  const request = await readSigningRequest(deps.db, input.orgId, input.id);
  if (!request) return fail(404, 'not_found', 'no such request');
  if (!request.signers.some((s) => s.userId === input.userId)) {
    return request.requestedBy === input.userId ? fail(403, 'not_a_signer', 'you are not a signer of this request') : fail(404, 'not_found', 'no such request');
  }
  if (request.status !== 'collecting') return fail(409, 'closed', `this request is ${request.status}`);
  const recorded = await recordDecline(deps.db, { orgId: input.orgId, requestId: input.id, userId: input.userId, now });
  if (!recorded) return fail(409, 'already_answered', 'you have already signed or declined this request');
  const updated = (await readSigningRequest(deps.db, input.orgId, input.id)) as StoredRequest;
  if (reachableWeight(updated) < updated.threshold) {
    const closed = await closeSigningRequest(deps.db, {
      orgId: input.orgId,
      id: input.id,
      status: 'cancelled',
      from: ['collecting'],
      now,
      error: 'enough signers declined that it can no longer be signed',
    });
    return { ok: true, closed };
  }
  return { ok: true, closed: false };
}
