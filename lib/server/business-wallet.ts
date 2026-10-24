/**
 * The Business Splash Wallet's flows (v2 §4.1), on top of the signature
 * collection in lib/server/wallet-signing.ts and the builders in
 * lib/server/sui-v2-builders.ts.
 *
 *   Create   The owners have enrolled passkeys. The server builds the
 *            multisig (lib/wallet/business-multisig.ts: 2-of-N by default,
 *            single-signer only when chosen), then asks the FOUNDER to sign
 *            `nominate_wallet` (Phase 1 R2: only the founder nominates). When
 *            that executes, it asks the new multisig's members to sign
 *            `register_wallet`, which Move accepts only from the multisig
 *            itself, recomputing its address from the keys. Two requests,
 *            each simulated before anyone signs, each sponsored.
 *   Rotate   Signed by the current wallet's quorum, then confirmed by the new
 *            wallet's quorum (two steps, as Move requires).
 *   Members  add_owner / remove_owner / set_recovery_party, wallet-only once
 *            a wallet is registered.
 *   Pay      create_for_wallet + confirm_from_business_wallet_balance with
 *            max_fee, FeeConfig and Registry, signed by the quorum.
 *   Migrate  Detect USDC left in members' own passkey wallets (read-only
 *            balance queries) and let each member move theirs with a plain
 *            transfer they sign alone (Sky's decision), gasless.
 *
 * Every flow names the org's own account (`expect.accountId`) and builds
 * bytes the describer will accept for that account only.
 */
import { PasskeyPublicKey } from '@mysten/sui/keypairs/passkey';
import { fromBase64, normalizeSuiAddress, toBase64 } from '@mysten/sui/utils';

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
  registerWalletTx,
  rotateWalletTx,
  walletMembershipTx,
  type OwnedCoinRef,
  type SharedRef,
  type V2Chain,
  type WalletPayment,
} from '@/lib/server/sui-v2-builders';
import { openSigningRequest, type SigningDeps, type SigningFailure, type RequestView } from '@/lib/server/wallet-signing';
import type { StoredRequest } from '@/lib/server/wallet-signing-store';

export type WalletContext = {
  signing: SigningDeps;
  chain: V2Chain;
  /** The org's BusinessAccount, shared. */
  account: SharedRef;
  /** Epoch and chain id for a gasless transfer's ValidDuring window. */
  validity?: () => Promise<{ epoch: bigint; chain: string; nonce: number }>;
};

/** A stored wallet: its multisig key and who each member is. */
export type WalletMembers = {
  multisigPublicKey: string;
  members: Array<{ userId: string; publicKey: string; weight: number }>;
};

type NextStep =
  | ({ purpose: 'register_wallet'; singleSigner: boolean } & WalletMembers)
  | ({ purpose: 'confirm_wallet_rotation' } & WalletMembers);

type Result = { ok: true; request: RequestView } | SigningFailure;

const refuse = (status: number, code: string, error: string): SigningFailure => ({ ok: false, status, code, error });

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

/**
 * Start a wallet for this org: the founder signs the nomination; the
 * registration request follows when it executes (`continueWalletSteps`).
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
): Promise<Result | { ok: false; status: number; code: string; error: string }> {
  let wallet: BusinessMultisig;
  try {
    wallet = buildBusinessMultisig({ members: input.owners, threshold: input.threshold, singleSignerChosen: input.singleSignerChosen });
  } catch (error) {
    const e = error as { code?: string; message?: string };
    return refuse(400, e.code ?? 'bad_wallet', e.message ?? 'the wallet could not be built');
  }
  const gas = await sponsoredGas(ctx);
  if (!gas) return refuse(503, 'no_sponsor', 'business wallet transactions need a gas sponsor, and none is configured');
  const founder = passkeySuiKey(input.founder.passkeyPublicKey);
  const bytes = await nominateWalletTx(ctx.chain, {
    founder: founder.address,
    account: ctx.account,
    wallet: wallet.address,
    singleSigner: wallet.singleSigner,
    gas,
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
    nextStep: next,
  });
}

/**
 * After a request executes: open the step that follows it. The nomination is
 * followed by the registration (signed by the new multisig); a rotation by
 * its confirmation (signed by the new wallet).
 */
export async function continueWalletSteps(ctx: WalletContext, executed: StoredRequest): Promise<Result | null> {
  const next = executed.nextStep as NextStep | null;
  if (!next) return null;
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
  return openSigningRequest(ctx.signing, {
    orgId: executed.orgId,
    requestedBy: executed.requestedBy,
    purpose: 'confirm_wallet_rotation',
    dedupeKey: 'wallet:rotate',
    transactionBytes: bytes,
    signer: { kind: 'multisig', multisigPublicKey: next.multisigPublicKey, members: next.members },
    gasMode: 'sponsored',
  });
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
  const gas = await sponsoredGas(ctx);
  if (!gas) return refuse(503, 'no_sponsor', 'business wallet transactions need a gas sponsor, and none is configured');
  const current = registration(input.current);
  const bytes = await rotateWalletTx(ctx.chain, {
    currentWallet: current.address,
    account: ctx.account,
    keys: wallet.members.map((m) => fromBase64(m.suiPublicKey)),
    weights: wallet.members.map((m) => m.weight),
    threshold: wallet.threshold,
    singleSignerAck: wallet.singleSigner,
    gas,
  });
  const next: NextStep = { purpose: 'confirm_wallet_rotation', ...asMembers(wallet) };
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

/** A payment from the business wallet, signed by its quorum. */
export async function requestWalletPayment(
  ctx: WalletContext,
  input: { orgId: string; requestedBy: string; wallet: WalletMembers; payment: Omit<WalletPayment, 'wallet' | 'account' | 'gas'> },
): Promise<Result> {
  const gas = await sponsoredGas(ctx);
  if (!gas) return refuse(503, 'no_sponsor', 'business wallet transactions need a gas sponsor, and none is configured');
  let bytes: Uint8Array;
  try {
    bytes = await payFromWalletTx(ctx.chain, { ...input.payment, wallet: registration(input.wallet).address, account: ctx.account, gas });
  } catch (error) {
    const e = error as { code?: string; message?: string };
    return refuse(400, e.code ?? 'bad_payment', e.message ?? 'the payment could not be built');
  }
  return openSigningRequest(ctx.signing, {
    orgId: input.orgId,
    requestedBy: input.requestedBy,
    purpose: 'wallet_payment',
    // The payment reference is the idempotency key on chain too: one intent
    // per reference, ever (derived_object::claim).
    dedupeKey: `pay:${Buffer.from(input.payment.paymentRef).toString('hex')}`,
    transactionBytes: bytes,
    signer: { kind: 'multisig', ...input.wallet },
    gasMode: 'sponsored',
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

/**
 * "Move to your business wallet": the member's own transfer, which they sign
 * alone, of everything their passkey wallet holds in USDC. Gasless unless
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
