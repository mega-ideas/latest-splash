/**
 * The Business Splash Wallet's flows (v2 §4.1), on top of the signature
 * collection in lib/server/wallet-signing.ts and the builders in
 * lib/server/sui-v2-builders.ts.
 *
 *   Create   The owners have enrolled passkeys. `planBusinessWallet` decides
 *            who is in the wallet: every owner (role admin) with an active
 *            passkey on this site, and nobody is left out silently (an owner
 *            without one blocks the wallet until the founder confirms, by
 *            name, that they are excluded). A wallet one member could sign
 *            alone is built only when the business chose it and, if there is
 *            more than one owner, every other owner has agreed to that exact
 *            wallet. The founder is the BusinessAccount's on-chain `owner`,
 *            read from the chain. The founder then signs one transaction that
 *            makes every member an on-chain owner (register_wallet refuses
 *            anyone else) and nominates the wallet; when it executes, the new
 *            multisig's members are asked to sign `register_wallet`, which
 *            Move accepts only from the multisig itself.
 *   Rotate   The current wallet (read from the BusinessAccount on chain) signs
 *            the rotation, the new wallet's quorum confirms it, and then the
 *            old wallet's quorum is asked to move its USDC to the new one.
 *   Members  add_owner / remove_owner / set_recovery_party, wallet-only once a
 *            wallet is registered.
 *   Pay      A new payment: create_for_wallet + confirm_from_business_wallet_balance
 *            with max_fee, FeeConfig and Registry. An existing intent (a staff
 *            member's, over their rule): its payee, principal, rate and expiry
 *            are read from the chain and bound into the request, so the quorum
 *            sees what it pays.
 *   Migrate  Detect USDC left in members' own passkey wallets (read-only) and
 *            let each member move theirs with a plain transfer they sign
 *            alone (Sky's decision), gasless.
 *
 * Every flow names the org's own account (`ctx.account`) and builds bytes the
 * describer will accept for that account only.
 */
import { PasskeyPublicKey } from '@mysten/sui/keypairs/passkey';
import { fromBase64, normalizeStructTag, normalizeSuiAddress, toBase64 } from '@mysten/sui/utils';

import {
  buildBusinessMultisig,
  multisigFromBase64,
  type BusinessMultisig,
  type WalletMemberInput,
} from '@/lib/wallet/business-multisig';
import {
  cancelWalletRotationTx,
  confirmWalletRotationTx,
  memberToWalletTransferTx,
  nominateWalletTx,
  payFromWalletTx,
  payOpenIntentFromWalletTx,
  registerWalletTx,
  rotateWalletTx,
  V2_KIND,
  walletMembershipTx,
  type OwnedCoinRef,
  type SharedRef,
  type V2Chain,
  type WalletPayment,
} from '@/lib/server/sui-v2-builders';
import { openSigningRequest, type SigningDeps, type SigningFailure, type RequestView, type WithdrawalSigningDetails } from '@/lib/server/wallet-signing';
import { listSigningRequests, type DrizzleDb, type StoredRequest } from '@/lib/server/wallet-signing-store';
import type { KytProvider } from '@/lib/compliance/kyt';
import { recipientScreeningGate } from '@/lib/server/kyt-screenings';

/** What the BusinessAccount says on chain, read fresh for each flow. */
export type AccountState = {
  /** The founder: the only address that may nominate a wallet. */
  owner: string;
  owners: string[];
  /** The registered business wallet, if any. */
  wallet: string | null;
  /** A rotation proposed and not yet confirmed. */
  pendingWallet: string | null;
  nominatedWallet: string | null;
  /** How many times a wallet registered or rotated: each SpendPolicy belongs to one generation (§4.2). */
  walletEpoch?: bigint;
};

/** An existing intent, read from the chain (payment_intent::PaymentIntent). */
export type IntentState = {
  id: string;
  initialSharedVersion: string | number;
  /** The BusinessAccount it is bound to. */
  account: string | null;
  /** Who opened it (`sender` on chain): a staff member, or the wallet. */
  maker?: string | null;
  recipient: string;
  /** Hex of the 32-byte beneficiary commitment on a bank payout; empty otherwise. */
  beneficiaryRef?: string;
  amountMinor: bigint;
  kind: number;
  targetCurrency: string;
  fxRateUsdLocal: bigint;
  expiresAtMs: bigint;
  /** 0 pending, 1 confirmed, 2 expired, 3 cancelled. */
  status: number;
  /** The settlement asset, a full type tag. */
  asset: string;
};

export type WalletContext = {
  signing: SigningDeps;
  chain: V2Chain;
  /** The org's BusinessAccount, shared. */
  account: SharedRef;
  /** The org's BusinessAccount as the chain has it now. */
  readAccount: () => Promise<AccountState>;
  /** An intent object, or null if there is none with that id. */
  readIntent?: (id: string) => Promise<IntentState | null>;
  /** USDC held at an address: in coin objects and in its address balance. */
  readUsdc?: (address: string) => Promise<{ coinMinor: bigint; addressBalanceMinor: bigint }>;
  /**
   * USDC a payment from this wallet may not use (v2 §4.3), given the balance
   * just read: every held or blocked deposit of the business (at any of its
   * wallets, so holds survive a rotation) plus anything the balance shows
   * beyond what the deposit watcher has accounted for. The live context runs
   * the watcher first. A payment Splash builds never spends it.
   */
  heldUsdc?: (wallet: string, balanceMinor: bigint) => Promise<bigint>;
  /** Whether plain USDC transfers go through the gasless lane (STABLECOIN_GASLESS). */
  gasless?: () => boolean;
  /** Epoch and chain id for a gasless transfer's ValidDuring window. */
  validity?: () => Promise<{ epoch: bigint; chain: string; nonce: number }>;
  /**
   * The server's screening provider (v2 §4.6): a recipient's stale CLEAR is
   * screened again before a payment to it is opened. Absent, a stale CLEAR
   * is refused. A payment is never opened without a fresh CLEAR either way.
   */
  kyt?: KytProvider | null;
  /** How old that CLEAR may be (KYT_SCREENING_MAX_AGE_HOURS; tests). */
  screeningMaxAgeMs?: number;
};

/** A stored wallet: its multisig key and who each member is. */
export type WalletMembers = {
  multisigPublicKey: string;
  members: Array<{ userId: string; publicKey: string; weight: number }>;
};

type NextStep =
  | ({ purpose: 'register_wallet'; singleSigner: boolean } & WalletMembers)
  | ({ purpose: 'confirm_wallet_rotation'; from: WalletMembers } & WalletMembers)
  | { purpose: 'rotation_transfer'; from: WalletMembers; to: string };

type Result = { ok: true; request: RequestView } | SigningFailure;
export type PlanFailure = SigningFailure & { details?: Record<string, unknown> };

const refuse = (status: number, code: string, error: string, details?: Record<string, unknown>): PlanFailure => ({ ok: false, status, code, error, ...(details ? { details } : {}) });

/**
 * A payment to a recipient is opened only when this business's newest
 * screening of it is a fresh CLEAR (v2 §4.6): BLOCK 403, REVIEW and
 * unscreened 409, a stale CLEAR screened again (ctx.kyt) or refused. The
 * signing layer checks the same again before each signature
 * (lib/server/payment-compliance-gate.ts). Every Splash-built payment to a
 * wallet or exchange recipient calls this; a bank payout pays the business's
 * verified partner deposit address and goes through the payout route.
 */
export async function recipientCleared(ctx: WalletContext, orgId: string, recipient: string, requestedBy: string): Promise<PlanFailure | null> {
  const refused = await recipientScreeningGate(
    { db: ctx.signing.db, orgId, now: (ctx.signing.now ?? (() => new Date()))(), kyt: ctx.kyt ?? null, ...(ctx.screeningMaxAgeMs ? { maxAgeMs: ctx.screeningMaxAgeMs } : {}), requestedBy },
    recipient,
  );
  return refused ? refuse(refused.status, refused.code, refused.error) : null;
}

function passkeySuiKey(compressed: string): { suiKey: string; address: string } {
  const key = new PasskeyPublicKey(fromBase64(compressed));
  return { suiKey: toBase64(key.toSuiBytes()), address: key.toSuiAddress() };
}

function asMembers(wallet: BusinessMultisig): WalletMembers {
  return {
    multisigPublicKey: wallet.multisigPublicKey,
    members: wallet.members.map((m) => ({ userId: m.userId, publicKey: m.suiPublicKey, weight: m.weight })),
  };
}

/** The wallet a request was signed by. */
function membersOf(request: StoredRequest): WalletMembers | null {
  if (request.signerKind !== 'multisig' || !request.multisigPublicKey) return null;
  return { multisigPublicKey: request.multisigPublicKey, members: request.signers.map((s) => ({ userId: s.userId, publicKey: s.publicKey, weight: s.weight })) };
}

function registration(members: WalletMembers) {
  const ms = multisigFromBase64(members.multisigPublicKey);
  const keys = ms.getPublicKeys();
  return {
    address: normalizeSuiAddress(ms.toSuiAddress()),
    keys: keys.map((k) => k.publicKey.toSuiBytes()),
    weights: keys.map((k) => k.weight),
    threshold: ms.getThreshold(),
    singleSigner: keys.some((k) => k.weight >= ms.getThreshold()),
  };
}

async function sponsoredGas(ctx: WalletContext) {
  if (!ctx.signing.sponsor) return null;
  return ctx.signing.sponsor.gasFor();
}

async function accountNow(ctx: WalletContext): Promise<AccountState | PlanFailure> {
  try {
    const a = await ctx.readAccount();
    return {
      owner: normalizeSuiAddress(a.owner),
      owners: a.owners.map((o) => normalizeSuiAddress(o)),
      wallet: a.wallet ? normalizeSuiAddress(a.wallet) : null,
      pendingWallet: a.pendingWallet ? normalizeSuiAddress(a.pendingWallet) : null,
      nominatedWallet: a.nominatedWallet ? normalizeSuiAddress(a.nominatedWallet) : null,
      ...(a.walletEpoch !== undefined ? { walletEpoch: BigInt(a.walletEpoch) } : {}),
    };
  } catch {
    return refuse(502, 'account_unreadable', 'the business account could not be read from the chain, so nothing was built');
  }
}

const isFailure = (x: unknown): x is PlanFailure => typeof x === 'object' && x !== null && (x as { ok?: unknown }).ok === false;

// ─── Who is in the wallet ───────────────────────────────────────────────────

/** An owner who can be a wallet member: one active passkey on this site. */
export type WalletCandidate = { userId: string; publicKey: string; address: string; founder: boolean };

/**
 * Who the new wallet is made of, or why it cannot be built yet.
 *
 * `candidates`: every owner with an active passkey here (one each; the
 * database allows one active passkey per person per site). `missing`: owners
 * with none. `consents`: owners who agreed to the proposed single-signer
 * wallet. The person who proposes a single-signer wallet (the founder, or
 * for a rotation the owner proposing it) cannot choose it for the others.
 * Pure, so the route and the tests decide the same way.
 */
export function planBusinessWallet(input: {
  requestedBy: string;
  candidates: WalletCandidate[];
  missing: string[];
  threshold?: number;
  singleSignerChosen?: boolean;
  consents?: string[];
  confirmExcluded?: string[];
  /** A rotation: any owner who is a member may propose it; there is no nomination. */
  rotation?: boolean;
}): { ok: true; founder: WalletCandidate | null; owners: WalletMemberInput[]; wallet: BusinessMultisig } | PlanFailure {
  const founder = input.candidates.find((c) => c.founder) ?? null;
  const proposer = input.rotation ? input.candidates.find((c) => c.userId === input.requestedBy) : founder;
  if (input.rotation) {
    if (!proposer) return refuse(403, 'not_a_member', 'only an owner with a passkey here can propose new wallet signers');
  } else {
    if (!founder) {
      return refuse(409, 'no_founder_passkey', "the business account's owner has no passkey on this site, so nobody can nominate the wallet");
    }
    if (founder.userId !== input.requestedBy) return refuse(403, 'not_the_founder', 'the founder starts the business wallet, with their passkey');
  }
  const chooser = proposer as WalletCandidate;

  if (input.missing.length > 0) {
    const confirmed = [...(input.confirmExcluded ?? [])].sort().join();
    if (confirmed !== [...input.missing].sort().join()) {
      return refuse(
        409,
        'owners_without_passkey',
        'some owners have no passkey yet, so they would not be signers of the wallet; ask them to add one, or confirm by name that they are left out',
        { missing: [...input.missing].sort() },
      );
    }
  }

  const owners = input.candidates.map((c) => ({ userId: c.userId, publicKey: c.publicKey }));
  let wallet: BusinessMultisig;
  try {
    wallet = buildBusinessMultisig({ members: owners, threshold: input.threshold, singleSignerChosen: input.singleSignerChosen });
  } catch (error) {
    const e = error as { code?: string; message?: string };
    return refuse(400, e.code ?? 'bad_wallet', e.message ?? 'the wallet could not be built');
  }
  if (wallet.singleSigner && input.candidates.length > 1) {
    // D1: "1-of-1 only if the business explicitly chooses it (owners record
    // that choice)". With co-owners, the founder alone cannot choose it.
    const agreed = new Set(input.consents ?? []);
    const waiting = input.candidates.filter((c) => c.userId !== chooser.userId && !agreed.has(c.userId)).map((c) => c.userId);
    if (waiting.length > 0) {
      return refuse(409, 'consent_needed', 'one owner could sign for this wallet alone; every other owner must agree to that first', {
        wallet: wallet.address,
        waiting: waiting.sort(),
      });
    }
  }
  return { ok: true, founder, owners, wallet };
}

// ─── Create ─────────────────────────────────────────────────────────────────

/**
 * Start a wallet for this org: the founder signs the nomination (adding every
 * member as an on-chain owner first); the registration request follows when
 * it executes (`continueWalletSteps`).
 */
export async function startBusinessWallet(
  ctx: WalletContext,
  input: {
    orgId: string;
    requestedBy: string;
    founder: { userId: string; passkeyPublicKey: string };
    owners: WalletMemberInput[];
    threshold?: number;
    singleSignerChosen?: boolean;
  },
): Promise<Result> {
  let wallet: BusinessMultisig;
  try {
    wallet = buildBusinessMultisig({ members: input.owners, threshold: input.threshold, singleSignerChosen: input.singleSignerChosen });
  } catch (error) {
    const e = error as { code?: string; message?: string };
    return refuse(400, e.code ?? 'bad_wallet', e.message ?? 'the wallet could not be built');
  }
  const account = await accountNow(ctx);
  if (isFailure(account)) return account;
  if (account.wallet) return refuse(409, 'wallet_registered', 'this business already has a business wallet; change its signers with a rotation');
  const founder = passkeySuiKey(input.founder.passkeyPublicKey);
  if (normalizeSuiAddress(founder.address) !== account.owner) {
    return refuse(403, 'not_the_founder', "this passkey is not the business account's owner key, so it cannot nominate the wallet");
  }
  const gas = await sponsoredGas(ctx);
  if (!gas) return refuse(503, 'no_sponsor', 'business wallet transactions need a gas sponsor, and none is configured');
  const memberAddresses = wallet.members.map((m) => normalizeSuiAddress(m.address));
  const onChain = new Set(account.owners);
  const addOwners = memberAddresses.filter((a) => !onChain.has(a));
  const bytes = await nominateWalletTx(ctx.chain, {
    founder: founder.address,
    account: ctx.account,
    wallet: wallet.address,
    singleSigner: wallet.singleSigner,
    gas,
    addOwners,
  });
  const next: NextStep = { purpose: 'register_wallet', singleSigner: wallet.singleSigner, ...asMembers(wallet) };
  return openSigningRequest(ctx.signing, {
    orgId: input.orgId,
    requestedBy: input.requestedBy,
    purpose: 'nominate_wallet',
    dedupeKey: 'wallet:create',
    transactionBytes: bytes,
    signer: { kind: 'single', userId: input.founder.userId, publicKey: founder.suiKey },
    gasMode: 'sponsored',
    members: memberAddresses,
    nextStep: next,
  });
}

/**
 * After a request executes: open the step that follows it. The nomination is
 * followed by the registration (signed by the new multisig); a rotation by
 * its confirmation (signed by the new wallet); a confirmation by the old
 * wallet moving its USDC to the new one.
 */
export async function continueWalletSteps(ctx: WalletContext, executed: StoredRequest): Promise<Result | null> {
  const next = executed.nextStep as NextStep | null;
  // Other follow-ups (a spending-rule reissue, §4.2) are not the wallet's.
  if (!next || !['register_wallet', 'confirm_wallet_rotation', 'rotation_transfer'].includes(next.purpose)) return null;
  if (next.purpose === 'rotation_transfer') {
    return requestRotationTransfer(ctx, { orgId: executed.orgId, requestedBy: executed.requestedBy, from: next.from, to: next.to });
  }
  const gas = await sponsoredGas(ctx);
  if (!gas) return refuse(503, 'no_sponsor', 'business wallet transactions need a gas sponsor, and none is configured');
  const reg = registration(next);
  if (next.purpose === 'register_wallet') {
    const bytes = await registerWalletTx(ctx.chain, {
      wallet: reg.address,
      account: ctx.account,
      keys: reg.keys,
      weights: reg.weights,
      threshold: reg.threshold,
      singleSignerAck: next.singleSigner,
      gas,
    });
    return openSigningRequest(ctx.signing, {
      orgId: executed.orgId,
      requestedBy: executed.requestedBy,
      purpose: 'register_wallet',
      dedupeKey: 'wallet:create',
      transactionBytes: bytes,
      signer: { kind: 'multisig', multisigPublicKey: next.multisigPublicKey, members: next.members },
      gasMode: 'sponsored',
    });
  }
  const bytes = await confirmWalletRotationTx(ctx.chain, { newWallet: reg.address, account: ctx.account, gas });
  const after: NextStep = { purpose: 'rotation_transfer', from: next.from, to: reg.address };
  return openSigningRequest(ctx.signing, {
    orgId: executed.orgId,
    requestedBy: executed.requestedBy,
    purpose: 'confirm_wallet_rotation',
    dedupeKey: 'wallet:rotate',
    transactionBytes: bytes,
    signer: { kind: 'multisig', multisigPublicKey: next.multisigPublicKey, members: next.members },
    gasMode: 'sponsored',
    nextStep: after,
  });
}

/**
 * The wallet the BusinessAccount names on chain now, with its members as
 * Splash recorded them when that wallet registered or was confirmed. Null if
 * there is no wallet, or if the chain names one Splash did not set up (then
 * nothing is built for it).
 */
export async function currentWalletMembers(
  ctx: WalletContext,
  db: DrizzleDb,
  orgId: string,
): Promise<{ ok: true; address: string; members: WalletMembers; account: AccountState } | PlanFailure> {
  const account = await accountNow(ctx);
  if (isFailure(account)) return account;
  if (!account.wallet) return refuse(409, 'no_wallet', 'register the business wallet first');
  const executed = await listSigningRequests(db, orgId, ['executed']);
  const source = executed.find((r) => (r.purpose === 'register_wallet' || r.purpose === 'confirm_wallet_rotation') && r.senderAddress === account.wallet);
  const members = source ? membersOf(source) : null;
  if (!members) return refuse(409, 'wallet_unknown', 'the business account names a wallet Splash has no record of setting up, so nothing is built for it');
  return { ok: true, address: account.wallet, members, account };
}

/** A wallet's keys, weights, threshold and address, from its stored members. */
export function walletRegistration(members: WalletMembers) {
  return registration(members);
}

/**
 * The members of a wallet Splash set up at `address` (the current one, or an
 * earlier one after a rotation), from the executed registration or
 * confirmation that made it the business's. Null if Splash has no record.
 */
export async function recordedWalletMembers(db: DrizzleDb, orgId: string, address: string): Promise<WalletMembers | null> {
  const executed = await listSigningRequests(db, orgId, ['executed']);
  const source = executed.find(
    (r) => (r.purpose === 'register_wallet' || r.purpose === 'confirm_wallet_rotation') && r.senderAddress === normalizeSuiAddress(address),
  );
  return source ? membersOf(source) : null;
}

/** Propose new signers. The current wallet signs; the new one confirms after. */
export async function startWalletRotation(
  ctx: WalletContext,
  input: { orgId: string; requestedBy: string; current: WalletMembers; owners: WalletMemberInput[]; threshold?: number; singleSignerChosen?: boolean },
): Promise<Result> {
  let wallet: BusinessMultisig;
  try {
    wallet = buildBusinessMultisig({ members: input.owners, threshold: input.threshold, singleSignerChosen: input.singleSignerChosen });
  } catch (error) {
    const e = error as { code?: string; message?: string };
    return refuse(400, e.code ?? 'bad_wallet', e.message ?? 'the wallet could not be built');
  }
  const current = registration(input.current);
  if (wallet.address === current.address) return refuse(400, 'same_wallet', 'these are the signers the wallet has already');
  const gas = await sponsoredGas(ctx);
  if (!gas) return refuse(503, 'no_sponsor', 'business wallet transactions need a gas sponsor, and none is configured');
  const bytes = await rotateWalletTx(ctx.chain, {
    currentWallet: current.address,
    account: ctx.account,
    keys: wallet.members.map((m) => fromBase64(m.suiPublicKey)),
    weights: wallet.members.map((m) => m.weight),
    threshold: wallet.threshold,
    singleSignerAck: wallet.singleSigner,
    gas,
  });
  const next: NextStep = { purpose: 'confirm_wallet_rotation', from: input.current, ...asMembers(wallet) };
  return openSigningRequest(ctx.signing, {
    orgId: input.orgId,
    requestedBy: input.requestedBy,
    purpose: 'rotate_wallet',
    dedupeKey: 'wallet:rotate',
    transactionBytes: bytes,
    signer: { kind: 'multisig', ...input.current },
    gasMode: 'sponsored',
    nextStep: next,
  });
}

/** The current wallet withdraws a rotation the new one has not confirmed. */
export async function cancelWalletRotation(ctx: WalletContext, input: { orgId: string; requestedBy: string; current: WalletMembers }): Promise<Result> {
  const gas = await sponsoredGas(ctx);
  if (!gas) return refuse(503, 'no_sponsor', 'business wallet transactions need a gas sponsor, and none is configured');
  const bytes = await cancelWalletRotationTx(ctx.chain, { currentWallet: registration(input.current).address, account: ctx.account, gas });
  return openSigningRequest(ctx.signing, {
    orgId: input.orgId,
    requestedBy: input.requestedBy,
    purpose: 'cancel_wallet_rotation',
    dedupeKey: 'wallet:rotate:cancel',
    transactionBytes: bytes,
    signer: { kind: 'multisig', ...input.current },
    gasMode: 'sponsored',
  });
}

/**
 * After a rotation is confirmed, the old wallet still holds whatever sat in
 * its address balance. Its own quorum moves all of it to the new wallet in
 * one plain transfer (gasless when STABLECOIN_GASLESS is on). Nothing is
 * asked for when it holds nothing. Allowances the old wallet funded name it
 * as funder and are revoked and reissued with the spending rules (§4.2).
 * Held and blocked USDC moves with the rest, and stays held: holds count by
 * business, not by address (lib/server/wallet-funding-store.ts heldUsdcMinor),
 * and the transfer itself is never recorded as a new deposit.
 */
export async function requestRotationTransfer(
  ctx: WalletContext,
  input: { orgId: string; requestedBy: string; from: WalletMembers; to: string },
): Promise<Result | null> {
  if (!ctx.readUsdc || !ctx.validity) return refuse(503, 'no_chain', 'the chain cannot be read, so no transfer can be built');
  const from = registration(input.from).address;
  const held = await ctx.readUsdc(from);
  if (held.addressBalanceMinor <= 0n) return null;
  const gasless = ctx.gasless ? ctx.gasless() : true;
  const sponsor = gasless ? undefined : (await sponsoredGas(ctx)) ?? undefined;
  if (!gasless && !sponsor) return refuse(503, 'no_sponsor', 'gasless transfers are off and no gas sponsor is configured');
  const bytes = await memberToWalletTransferTx({
    member: from,
    wallet: input.to,
    usdcType: ctx.chain.usdcType,
    coins: [],
    addressBalanceMinor: held.addressBalanceMinor,
    validity: await ctx.validity(),
    sponsor,
  });
  return openSigningRequest(ctx.signing, {
    orgId: input.orgId,
    requestedBy: input.requestedBy,
    purpose: 'rotation_transfer',
    dedupeKey: 'wallet:rotate:funds',
    transactionBytes: bytes,
    signer: { kind: 'multisig', ...input.from },
    gasMode: gasless ? 'gasless' : 'sponsored',
    recipient: input.to,
  });
}

/** An owner membership change, signed by the wallet. */
export async function changeWalletMembership(
  ctx: WalletContext,
  input: { orgId: string; requestedBy: string; wallet: WalletMembers; change: 'add_owner' | 'remove_owner' | 'set_recovery_party'; address: string },
): Promise<Result> {
  const gas = await sponsoredGas(ctx);
  if (!gas) return refuse(503, 'no_sponsor', 'business wallet transactions need a gas sponsor, and none is configured');
  const bytes = await walletMembershipTx(ctx.chain, {
    wallet: registration(input.wallet).address,
    account: ctx.account,
    change: input.change,
    address: input.address,
    gas,
  });
  return openSigningRequest(ctx.signing, {
    orgId: input.orgId,
    requestedBy: input.requestedBy,
    purpose: 'wallet_membership',
    dedupeKey: `wallet:membership:${input.change}:${normalizeSuiAddress(input.address)}`,
    transactionBytes: bytes,
    signer: { kind: 'multisig', ...input.wallet },
    gasMode: 'sponsored',
  });
}

/**
 * Held funds are not spent (v2 §4.3). The wallet's USDC is read first, then
 * what of it is withheld (held, blocked, or not yet accounted for by the
 * deposit watcher, for that same balance); a payment is built only if the
 * rest covers principal plus the fee bound. Splash cannot freeze a wallet it
 * has no key to; it refuses to build, sponsor or route a payment that would
 * use held funds. Every Splash-built spend path calls this: wallet payments,
 * open-intent payments and the owners' second approval of a rule payment.
 */
export async function fundsOnHold(ctx: WalletContext, wallet: string, needMinor: bigint): Promise<PlanFailure | null> {
  if (!ctx.heldUsdc) return null;
  if (!ctx.readUsdc) return refuse(503, 'balance_unreadable', 'the wallet balance cannot be read here, so what is on hold cannot be checked and no payment was built');
  let balance: bigint;
  try {
    const b = await ctx.readUsdc(wallet);
    balance = b.coinMinor + b.addressBalanceMinor;
  } catch {
    return refuse(502, 'balance_unreadable', 'the wallet balance could not be read, so no payment was built');
  }
  let held: bigint;
  try {
    held = await ctx.heldUsdc(wallet, balance);
  } catch {
    return refuse(503, 'holds_unreadable', 'held deposits could not be read, so no payment was built');
  }
  if (held <= 0n) return null;
  const spendable = balance > held ? balance - held : 0n;
  if (needMinor > spendable) {
    return refuse(409, 'funds_on_hold', 'this payment would use funds that are on hold until their source is verified and screened', { heldMinor: held.toString(), spendableMinor: spendable.toString() });
  }
  return null;
}

/**
 * Sky's decision (§4.5): the payout instruction goes to the partner by API
 * BEFORE the deposit, keyed by the intent id and the expected amount. So a
 * bank payout (kind 4), and any payment to one of the business's partner
 * deposit addresses, is opened only by the withdrawal or supplier payout
 * route (lib/server/withdrawals.ts openBankPayout), never as a plain wallet
 * payment, a staff draft or an open intent the owners pay. Null lets it through.
 */
export async function payoutRouteOnly(db: DrizzleDb, orgId: string, payment: { kind: number; recipient: string }): Promise<PlanFailure | null> {
  const why = (error: string) => refuse(409, 'use_payout_route', error);
  if (payment.kind === V2_KIND.BANK_PAYOUT) {
    return why('a bank payout is opened only as a withdrawal or a supplier payout, so the partner is told before the money moves');
  }
  const { partnerDepositAddressesOf } = await import('./withdrawals-store.ts');
  const deposits = new Set((await partnerDepositAddressesOf(db, orgId)).map((a) => normalizeSuiAddress(a)));
  if (deposits.has(normalizeSuiAddress(payment.recipient))) {
    return why("this is the business's deposit address with a payout partner: pay it as a withdrawal or a supplier payout, so the partner is told before the money moves");
  }
  return null;
}

/**
 * A payment from the business wallet, signed by its quorum. With
 * `withdrawal`, it is a withdrawal to the business's own bank (v2 §4.4): the
 * request is opened as purpose `withdrawal`, and the bytes must be a bank
 * payout to exactly that deposit address, for exactly that beneficiary and
 * amount, or nothing is stored.
 */
export async function requestWalletPayment(
  ctx: WalletContext,
  input: {
    orgId: string;
    requestedBy: string;
    wallet: WalletMembers;
    payment: Omit<WalletPayment, 'wallet' | 'account' | 'gas'>;
    /** A withdrawal: the deposit address and commitment the bytes must carry, and what its signers are shown. */
    withdrawal?: {
      /** `withdrawal` (the business's own bank, §4.4) or `partner_payout` (a supplier's bank, §4.5). Default `withdrawal`. */
      purpose?: 'withdrawal' | 'partner_payout';
      depositAddress: string;
      beneficiaryRef: string;
      details?: WithdrawalSigningDetails;
    };
  },
): Promise<Result> {
  if (input.withdrawal) {
    if (input.payment.kind !== V2_KIND.BANK_PAYOUT) return refuse(400, 'not_a_bank_payout', 'a withdrawal or partner payout is a bank payout');
    if (normalizeSuiAddress(input.payment.recipient) !== normalizeSuiAddress(input.withdrawal.depositAddress)) {
      return refuse(400, 'wrong_recipient', "a withdrawal pays the business's partner deposit address only");
    }
  }
  const onHold = await fundsOnHold(ctx, registration(input.wallet).address, input.payment.amountMinor + input.payment.maxFeeMinor);
  if (onHold) return onHold;
  const gas = await sponsoredGas(ctx);
  if (!gas) return refuse(503, 'no_sponsor', 'business wallet transactions need a gas sponsor, and none is configured');
  if (!input.withdrawal) {
    // Before anything is built or stored: a bank payout, or a payment to a
    // partner deposit address, goes only through the payout route.
    const routed = await payoutRouteOnly(ctx.signing.db, input.orgId, input.payment);
    if (routed) return routed;
  }
  let bytes: Uint8Array;
  try {
    bytes = await payFromWalletTx(ctx.chain, { ...input.payment, wallet: registration(input.wallet).address, account: ctx.account, gas });
  } catch (error) {
    const e = error as { code?: string; message?: string };
    return refuse(400, e.code ?? 'bad_payment', e.message ?? 'the payment could not be built');
  }
  if (!input.withdrawal) {
    // Nothing is stored for a recipient that is not a fresh CLEAR here.
    const screened = await recipientCleared(ctx, input.orgId, input.payment.recipient, input.requestedBy);
    if (screened) return screened;
  }
  return openSigningRequest(ctx.signing, {
    orgId: input.orgId,
    requestedBy: input.requestedBy,
    purpose: input.withdrawal ? (input.withdrawal.purpose ?? 'withdrawal') : 'wallet_payment',
    // The payment reference is the idempotency key on chain too: one intent
    // per reference, ever (derived_object::claim).
    dedupeKey: `pay:${Buffer.from(input.payment.paymentRef).toString('hex')}`,
    transactionBytes: bytes,
    signer: { kind: 'multisig', ...input.wallet },
    gasMode: 'sponsored',
    ...(input.withdrawal
      ? {
          recipient: input.withdrawal.depositAddress,
          beneficiaryRef: input.withdrawal.beneficiaryRef,
          amountMinor: input.payment.amountMinor,
          ...(input.withdrawal.details ? { withdrawal: input.withdrawal.details } : {}),
        }
      : {}),
  });
}

/**
 * The test deposit that verifies a partner deposit address (v2 §4.4): one
 * plain USDC transfer of exactly `amountMinor` from the business wallet's
 * address balance to the deposit address, signed by the quorum, sponsored
 * (a partial transfer cannot use the gasless lane, which moves whole
 * balances). Held funds are never used.
 */
export async function requestPartnerTestDeposit(
  ctx: WalletContext,
  input: { orgId: string; requestedBy: string; wallet: WalletMembers; depositAddress: string; amountMinor: bigint; dedupeKey: string },
): Promise<Result> {
  if (input.amountMinor <= 0n) return refuse(400, 'bad_amount', 'the test deposit must be above zero');
  const from = registration(input.wallet).address;
  if (normalizeSuiAddress(input.depositAddress) === from) return refuse(400, 'own_wallet', 'the deposit address is the business wallet itself');
  const onHold = await fundsOnHold(ctx, from, input.amountMinor);
  if (onHold) return onHold;
  if (!ctx.validity) return refuse(503, 'no_chain', 'the chain cannot be read, so no transfer can be built');
  const gas = await sponsoredGas(ctx);
  if (!gas) return refuse(503, 'no_sponsor', 'business wallet transactions need a gas sponsor, and none is configured');
  let bytes: Uint8Array;
  try {
    bytes = await memberToWalletTransferTx({
      member: from,
      wallet: input.depositAddress,
      usdcType: ctx.chain.usdcType,
      coins: [],
      addressBalanceMinor: input.amountMinor,
      validity: await ctx.validity(),
      sponsor: gas,
    });
  } catch (error) {
    const e = error as { code?: string; message?: string };
    return refuse(400, e.code ?? 'bad_transfer', e.message ?? 'the test deposit could not be built');
  }
  return openSigningRequest(ctx.signing, {
    orgId: input.orgId,
    requestedBy: input.requestedBy,
    purpose: 'partner_test_deposit',
    dedupeKey: input.dedupeKey,
    transactionBytes: bytes,
    signer: { kind: 'multisig', ...input.wallet },
    gasMode: 'sponsored',
    recipient: input.depositAddress,
    amountMinor: input.amountMinor,
  });
}

/**
 * The owners pay an intent that already exists (a staff member opened it
 * over their spending rule). The intent is read from the chain here: it must
 * be this org's, still pending and unexpired, in USDC. Its payee, principal,
 * rate and expiry are bound into the request, so the describer refuses the
 * bytes for any other intent, the withdrawal must be exactly principal +
 * max_fee, and every signer sees the payee and amount.
 */
export async function requestOpenIntentPayment(
  ctx: WalletContext,
  input: {
    orgId: string;
    requestedBy: string;
    wallet: WalletMembers;
    intentId: string;
    maxFeeMinor: bigint;
    settleByMs: bigint;
    contentHash: Uint8Array;
    walrusBlobId: Uint8Array;
  },
): Promise<Result> {
  if (!ctx.readIntent) return refuse(503, 'no_chain', 'the intent cannot be read from the chain, so nothing was built');
  let intent: IntentState | null;
  try {
    intent = await ctx.readIntent(normalizeSuiAddress(input.intentId));
  } catch {
    return refuse(502, 'intent_unreadable', 'the payment could not be read from the chain, so nothing was built');
  }
  // Another org's intent reads as absent, like any other cross-tenant id.
  if (!intent || !intent.account || normalizeSuiAddress(intent.account) !== normalizeSuiAddress(ctx.account.objectId)) {
    return refuse(404, 'not_found', 'no such payment');
  }
  const now = BigInt(((ctx.signing.now ?? (() => new Date()))()).getTime());
  if (intent.status !== 0) return refuse(409, 'intent_not_open', 'this payment is no longer waiting to be paid');
  if (intent.expiresAtMs <= now) return refuse(409, 'intent_expired', 'this payment has expired');
  if (normalizeStructTag(intent.asset) !== normalizeStructTag(ctx.chain.usdcType)) return refuse(400, 'wrong_asset', 'a payment may move USDC only');
  if (intent.kind === V2_KIND.CROSS_CHAIN) {
    return refuse(400, 'cross_chain_not_built', 'a cross-chain payment is paid through a bridge adapter, which is not registered yet');
  }
  const routed = await payoutRouteOnly(ctx.signing.db, input.orgId, { kind: intent.kind, recipient: intent.recipient });
  if (routed) return routed;
  const onHold = await fundsOnHold(ctx, registration(input.wallet).address, intent.amountMinor + input.maxFeeMinor);
  if (onHold) return onHold;
  const gas = await sponsoredGas(ctx);
  if (!gas) return refuse(503, 'no_sponsor', 'business wallet transactions need a gas sponsor, and none is configured');
  let bytes: Uint8Array;
  try {
    bytes = await payOpenIntentFromWalletTx(ctx.chain, {
      wallet: registration(input.wallet).address,
      account: ctx.account,
      intent: { objectId: intent.id, initialSharedVersion: intent.initialSharedVersion },
      amountMinor: intent.amountMinor,
      maxFeeMinor: input.maxFeeMinor,
      settleByMs: input.settleByMs,
      contentHash: input.contentHash,
      walrusBlobId: input.walrusBlobId,
      gas,
    });
  } catch (error) {
    const e = error as { code?: string; message?: string };
    return refuse(400, e.code ?? 'bad_payment', e.message ?? 'the payment could not be built');
  }
  const screened = await recipientCleared(ctx, input.orgId, intent.recipient, input.requestedBy);
  if (screened) return screened;
  return openSigningRequest(ctx.signing, {
    orgId: input.orgId,
    requestedBy: input.requestedBy,
    purpose: 'wallet_payment',
    dedupeKey: `pay-intent:${normalizeSuiAddress(intent.id)}`,
    transactionBytes: bytes,
    signer: { kind: 'multisig', ...input.wallet },
    gasMode: 'sponsored',
    openIntent: {
      intentId: normalizeSuiAddress(intent.id),
      recipient: normalizeSuiAddress(intent.recipient),
      amountMinor: intent.amountMinor.toString(),
      kind: intent.kind,
      targetCurrency: intent.targetCurrency,
      fxRateUsdLocal: intent.fxRateUsdLocal.toString(),
      expiresAtMs: intent.expiresAtMs.toString(),
      asset: normalizeStructTag(intent.asset),
    },
  });
}

// ─── Migration from the per-person passkey wallets ───────────────────────────

export type MemberFunds = { userId: string; address: string; usdcMinor: bigint; coinMinor: bigint; addressBalanceMinor: bigint };

/** Read-only: how much USDC each member's own passkey wallet still holds. */
export async function detectMemberFunds(
  read: (address: string) => Promise<{ coinMinor: bigint; addressBalanceMinor: bigint }>,
  members: Array<{ userId: string; address: string }>,
): Promise<MemberFunds[]> {
  const out: MemberFunds[] = [];
  for (const m of members) {
    const b = await read(normalizeSuiAddress(m.address));
    out.push({ userId: m.userId, address: normalizeSuiAddress(m.address), coinMinor: b.coinMinor, addressBalanceMinor: b.addressBalanceMinor, usdcMinor: b.coinMinor + b.addressBalanceMinor });
  }
  return out.filter((m) => m.usdcMinor > 0n);
}

/** Coin objects in one migration transfer, at most. Well inside Sui's input limits. */
export const MAX_MIGRATION_COINS = 250;

/**
 * Every USDC coin object at an address, page by page, up to `cap`. `more`
 * says coins were left for a second transfer (the member runs it again).
 */
export async function collectCoins(
  list: (cursor: string | null) => Promise<{ objects: OwnedCoinRef[]; hasNextPage: boolean; cursor: string | null }>,
  cap = MAX_MIGRATION_COINS,
): Promise<{ coins: OwnedCoinRef[]; more: boolean }> {
  const coins: OwnedCoinRef[] = [];
  let cursor: string | null = null;
  for (;;) {
    const page = await list(cursor);
    for (const c of page.objects) {
      if (coins.length === cap) return { coins, more: true };
      coins.push(c);
    }
    if (!page.hasNextPage || !page.cursor) return { coins, more: false };
    cursor = page.cursor;
  }
}

/**
 * "Move to your business wallet": the member's own transfer, which they sign
 * alone, of what their passkey wallet holds in USDC. Gasless unless
 * STABLECOIN_GASLESS is off, in which case the sponsor pays.
 */
export async function requestMigrationTransfer(
  ctx: WalletContext,
  input: {
    orgId: string;
    member: { userId: string; passkeyPublicKey: string };
    businessWallet: string;
    coins: OwnedCoinRef[];
    addressBalanceMinor: bigint;
    gasless: boolean;
  },
): Promise<Result> {
  const member = passkeySuiKey(input.member.passkeyPublicKey);
  if (normalizeSuiAddress(input.businessWallet) === member.address) return refuse(400, 'same_wallet', 'this is already the business wallet');
  if (!ctx.validity) return refuse(503, 'no_chain', 'the chain cannot be read, so no transfer can be built');
  const validity = await ctx.validity();
  const sponsor = input.gasless ? undefined : (await sponsoredGas(ctx)) ?? undefined;
  if (!input.gasless && !sponsor) return refuse(503, 'no_sponsor', 'gasless transfers are off and no gas sponsor is configured');
  let bytes: Uint8Array;
  try {
    bytes = await memberToWalletTransferTx({
      member: member.address,
      wallet: input.businessWallet,
      usdcType: ctx.chain.usdcType,
      coins: input.coins,
      addressBalanceMinor: input.addressBalanceMinor,
      validity,
      sponsor,
    });
  } catch (error) {
    const e = error as { code?: string; message?: string };
    return refuse(400, e.code ?? 'bad_transfer', e.message ?? 'the transfer could not be built');
  }
  return openSigningRequest(ctx.signing, {
    orgId: input.orgId,
    requestedBy: input.member.userId,
    purpose: 'migration_transfer',
    dedupeKey: `migrate:${member.address}`,
    transactionBytes: bytes,
    signer: { kind: 'single', userId: input.member.userId, publicKey: member.suiKey },
    gasMode: input.gasless ? 'gasless' : 'sponsored',
    recipient: input.businessWallet,
  });
}
