/**
 * The live wiring for the Business Splash Wallet: Postgres, the chain
 * (SUI_NETWORK's fullnode), the gas sponsor, WhatsApp, for ONE org.
 *
 * Fails closed. No database, no v2 object ids, an org without its own
 * BusinessAccount id, or mainnet before the hardware passkey check is
 * recorded (lib/server/wallet-network-gate.ts) answers a refusal with the
 * reason, never a stand-in: in particular the account comes from
 * `organizations.sui_business_account_id` only, never from the single-tenant
 * SPLASH_BUSINESS_ACCOUNT_ID fallback, so one org's wallet transactions can
 * never name another's account. A missing sponsor is not a refusal here,
 * because reading the inbox needs none; every sponsored request is then
 * refused when it would be opened (503).
 *
 * What the wallet is, who the founder is and who the owners are on chain are
 * read from the BusinessAccount itself (`readAccount`), never inferred from
 * request history or memberships.
 */
import 'server-only';

import { randomInt } from 'node:crypto';

import { eq } from 'drizzle-orm';
import { normalizeStructTag, normalizeSuiAddress } from '@mysten/sui/utils';

import { relyingPartyId } from '@/lib/auth/passkey';
import { memberships, organizations, passkeyCredentials } from '@/lib/db/schema';
import { gaslessEnabled, SUI_USDC_COIN_TYPE } from '@/lib/payments/stablecoin-lane';
import { listApprovers } from '@/lib/server/approver-channels';
import { walletSigningNotifier } from '@/lib/server/approval-requests';
import { continueWalletSteps, type AccountState, type IntentState, type WalletContext } from '@/lib/server/business-wallet';
import { settleApprovalAsks } from '@/lib/server/payment-approval-asks';
import { v2ObjectIdsFromEnv, type SharedRef } from '@/lib/server/sui-v2-builders';
import { memberWalletAddresses, pickWalletMembers, type PasskeyRow } from '@/lib/server/wallet-members';
import { walletNetworkGate } from '@/lib/server/wallet-network-gate';
import type { ChainResult, SigningDeps, WalletChain } from '@/lib/server/wallet-signing';
import type { DrizzleDb } from '@/lib/server/wallet-signing-store';
import { walletSponsorFromEnv } from '@/lib/server/wallet-sponsor';

export type WalletDepsRefusal = { ok: false; status: number; error: string };

const initialVersions = new Map<string, string>();

async function sharedRef(objectId: string): Promise<SharedRef> {
  const id = normalizeSuiAddress(objectId);
  const cached = initialVersions.get(id);
  if (cached) return { objectId: id, initialSharedVersion: cached };
  const { suiClient } = await import('@/lib/sui');
  const { object } = await suiClient.core.getObject({ objectId: id });
  const owner = object.owner as { $kind?: string; Shared?: { initialSharedVersion: string } };
  if (owner.$kind !== 'Shared' || !owner.Shared) throw new Error(`${id} is not a shared object`);
  initialVersions.set(id, String(owner.Shared.initialSharedVersion));
  return { objectId: id, initialSharedVersion: String(owner.Shared.initialSharedVersion) };
}

export function liveChain(): WalletChain & { read(digest: string): Promise<ChainResult | null>; currentEpoch(): Promise<bigint> } {
  return {
    async simulate(bytes) {
      const [{ suiClient }, { observe }] = await Promise.all([import('@/lib/sui'), import('@/lib/server/stablecoin-chain')]);
      const result = observe(await suiClient.core.simulateTransaction({ transaction: bytes, include: { effects: true, balanceChanges: true, transaction: true }, doGasSelection: false }));
      return { success: result.success, error: result.error, balanceChanges: result.balanceChanges };
    },
    async execute(bytes, signatures) {
      const [{ suiClient }, { observe }] = await Promise.all([import('@/lib/sui'), import('@/lib/server/stablecoin-chain')]);
      const result = observe(await suiClient.core.executeTransaction({ transaction: bytes, signatures, include: { effects: true, balanceChanges: true, transaction: true } }));
      return { digest: result.digest, success: result.success, error: result.error };
    },
    async read(digest) {
      const [{ suiClient }, { observe }] = await Promise.all([import('@/lib/sui'), import('@/lib/server/stablecoin-chain')]);
      try {
        const result = observe(await suiClient.core.getTransaction({ digest, include: { effects: true, balanceChanges: true, transaction: true } }));
        return { digest: result.digest, success: result.success, error: result.error };
      } catch {
        return null;
      }
    },
    async currentEpoch() {
      const { suiClient } = await import('@/lib/sui');
      return BigInt((await suiClient.core.getCurrentSystemState()).systemState.epoch);
    },
  };
}

/** The USDC type wallet payments move: native USDC on this network (D6). */
export function walletUsdcType(env: NodeJS.ProcessEnv = process.env): string {
  return SUI_USDC_COIN_TYPE[(env.SUI_NETWORK ?? '').trim() === 'mainnet' ? 'mainnet' : 'testnet'];
}

// ─── Reading Move objects as JSON ───────────────────────────────────────────

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Option<T> as the fullnode renders it: null, the value, or `{ vec: [v] }`. */
function option(v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (isObject(v) && Array.isArray(v.vec)) return v.vec.length ? v.vec[0] : null;
  return v;
}
function address(v: unknown, what: string): string {
  if (typeof v !== 'string' || !/^(0x)?[0-9a-fA-F]{1,64}$/.test(v)) throw new Error(`${what} is not an address`);
  return normalizeSuiAddress(v);
}
function addressSet(v: unknown, what: string): string[] {
  const list = isObject(v) && Array.isArray(v.contents) ? v.contents : Array.isArray(v) ? v : null;
  if (!list) throw new Error(`${what} is not a set of addresses`);
  return list.map((x) => address(x, what));
}
function u64(v: unknown, what: string): bigint {
  if ((typeof v !== 'string' && typeof v !== 'number') || !/^\d+$/.test(String(v))) throw new Error(`${what} is not a u64`);
  return BigInt(v);
}

/** vector<u8> as hex: the fullnode renders it as a number array or as base64. */
function bytesHex(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (Array.isArray(v)) return Buffer.from(v.map((x) => Number(x))).toString('hex');
  if (typeof v === 'string') return Buffer.from(v, 'base64').toString('hex');
  return '';
}

async function readJsonObject(objectId: string, typeSuffix: string): Promise<{ json: Json; owner: unknown; type: string } | null> {
  const { suiClient } = await import('@/lib/sui');
  let object: { json?: unknown; owner: unknown; type: string };
  try {
    ({ object } = (await suiClient.core.getObject({ objectId, include: { json: true } })) as unknown as { object: { json?: unknown; owner: unknown; type: string } });
  } catch {
    return null;
  }
  if (!object.type.endsWith(typeSuffix)) throw new Error(`${objectId} is not a ${typeSuffix.slice(2)}`);
  if (!isObject(object.json)) throw new Error(`${objectId} could not be read`);
  return { json: object.json, owner: object.owner, type: object.type };
}

/** splash_core::business_account::BusinessAccount, as the chain has it now. */
export function parseBusinessAccount(json: Json): AccountState {
  const nominated = option(json.nominated_wallet);
  const pending = option(json.pending_wallet);
  const wallet = option(json.wallet);
  return {
    owner: address(json.owner, 'the account owner'),
    owners: addressSet(json.owners, 'the account owners'),
    wallet: wallet === null ? null : address(wallet, 'the wallet'),
    nominatedWallet: isObject(nominated) ? address(nominated.wallet, 'the nominated wallet') : null,
    pendingWallet: isObject(pending) ? address(pending.wallet, 'the pending wallet') : null,
    ...(json.wallet_epoch !== undefined ? { walletEpoch: u64(json.wallet_epoch, 'the wallet generation') } : {}),
  };
}

/** splash_core::payment_intent::PaymentIntent. */
export function parsePaymentIntent(id: string, json: Json, owner: unknown): IntentState {
  const shared = (owner as { $kind?: string; Shared?: { initialSharedVersion: string } }) ?? {};
  if (shared.$kind !== 'Shared' || !shared.Shared) throw new Error('the intent is not shared');
  const account = option(json.account);
  const asset = String(json.settlement_asset ?? '');
  return {
    id: normalizeSuiAddress(id),
    initialSharedVersion: String(shared.Shared.initialSharedVersion),
    account: account === null ? null : address(account, 'the intent account'),
    maker: json.sender === undefined ? null : address(json.sender, 'the intent maker'),
    recipient: address(json.recipient, 'the intent recipient'),
    beneficiaryRef: bytesHex(json.beneficiary_ref),
    amountMinor: u64(json.amount_usd, 'the intent amount'),
    kind: Number(u64(json.kind, 'the intent kind')),
    targetCurrency: String(json.target_currency ?? ''),
    fxRateUsdLocal: u64(json.fx_rate_usd_local, 'the intent rate'),
    expiresAtMs: u64(json.expires_at, 'the intent expiry'),
    status: Number(u64(json.status, 'the intent status')),
    // type_name strings carry no 0x prefix.
    asset: normalizeStructTag(asset.startsWith('0x') ? asset : `0x${asset}`),
  };
}

/** Everything the wallet flows need for one org, or why it cannot run. */
export async function liveWalletContext(orgId: string): Promise<{ ok: true; ctx: WalletContext; db: DrizzleDb } | WalletDepsRefusal> {
  if (!process.env.DATABASE_URL) return { ok: false, status: 503, error: 'the business wallet needs the database, and DATABASE_URL is not set' };
  const gate = walletNetworkGate();
  if (!gate.ok) return { ok: false, status: 503, error: gate.reason };
  const ids = v2ObjectIdsFromEnv();
  if (!ids.ok) return { ok: false, status: 503, error: ids.reason };

  const { getDb } = await import('@/lib/db/client');
  const db = getDb() as unknown as DrizzleDb;
  const [org] = await db.select({ accountId: organizations.suiBusinessAccountId, name: organizations.name }).from(organizations).where(eq(organizations.id, orgId)).limit(1);
  const accountId = (org?.accountId ?? '').trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(accountId)) {
    return { ok: false, status: 409, error: 'this business has no on-chain account yet, so it cannot have a business wallet' };
  }

  let account: SharedRef;
  let complianceConfig: SharedRef;
  let feeConfig: SharedRef;
  let registry: SharedRef;
  try {
    [account, complianceConfig, feeConfig, registry] = await Promise.all([
      sharedRef(accountId),
      sharedRef(ids.ids.complianceConfigId),
      sharedRef(ids.ids.feeConfigId),
      sharedRef(ids.ids.registryId),
    ]);
  } catch (error) {
    return { ok: false, status: 502, error: `the v2 objects could not be read from the chain: ${error instanceof Error ? error.message : 'read failed'}` };
  }

  const sponsor = await walletSponsorFromEnv();
  const usdcType = walletUsdcType();
  const { spendIdsFromEnv } = await import('@/lib/server/spend-rules-env');
  const spendIds = spendIdsFromEnv();
  const signing: SigningDeps = {
    db,
    chain: liveChain(),
    sponsor: sponsor.ok ? sponsor.sponsor : null,
    expect: {
      corePackageId: ids.ids.corePackageId,
      accountId,
      complianceConfigId: ids.ids.complianceConfigId,
      feeConfigId: ids.ids.feeConfigId,
      registryId: ids.ids.registryId,
      usdcType,
      // Spending rules (§4.2): without both ids, no splash_spend command is understood.
      ...(spendIds.ok ? { spendPackageId: spendIds.spendPackageId, policyRegistryId: spendIds.policyRegistryId } : {}),
    },
    notifier: walletSigningNotifier({ orgName: async () => org?.name ?? 'Your business', channels: listApprovers }),
  };
  const ctx: WalletContext = {
    signing,
    chain: { corePackageId: ids.ids.corePackageId, complianceConfig, feeConfig, registry, usdcType },
    account,
    readAccount: async () => {
      const read = await readJsonObject(accountId, '::business_account::BusinessAccount');
      if (!read) throw new Error('the business account could not be read');
      return parseBusinessAccount(read.json);
    },
    readIntent: async (id) => {
      const read = await readJsonObject(normalizeSuiAddress(id), '::payment_intent::PaymentIntent');
      return read ? parsePaymentIntent(id, read.json, read.owner) : null;
    },
    readUsdc: async (owner) => {
      const { suiClient } = await import('@/lib/sui');
      const { balance } = await suiClient.core.getBalance({ owner, coinType: usdcType });
      return { coinMinor: BigInt(balance.coinBalance), addressBalanceMinor: BigInt(balance.addressBalance) };
    },
    // Holds fail closed (v2 §4.3): the deposit watcher reads every transaction
    // to the wallet first, then held, blocked and unaccounted USDC is withheld.
    heldUsdc: async (wallet, balanceMinor) => {
      const [{ fundingDepsFor }, { walletFundsWithheld }] = await Promise.all([import('@/lib/server/wallet-funding-deps'), import('@/lib/server/wallet-funding')]);
      const withheld = await walletFundsWithheld(fundingDepsFor({ orgId, ctx, db }), balanceMinor, normalizeSuiAddress(wallet));
      if (!withheld.ok) throw new Error(withheld.error);
      return BigInt(withheld.withheldMinor);
    },
    gasless: () => gaslessEnabled(),
    validity: async () => {
      const { suiClient } = await import('@/lib/sui');
      const [{ systemState }, { chainIdentifier }] = await Promise.all([suiClient.core.getCurrentSystemState(), suiClient.core.getChainIdentifier()]);
      return { epoch: BigInt(systemState.epoch), chain: chainIdentifier, nonce: randomInt(0, 2 ** 32) };
    },
  };
  // A withdrawal signature is taken only while the bank account and deposit
  // address it pays are still the ones its bytes commit to (v2 §4.4).
  signing.beforeSign = async (request) => {
    if (request.purpose !== 'withdrawal' && request.purpose !== 'partner_payout') return null;
    const { withdrawalBeforeSign } = await import('@/lib/server/withdrawals');
    return withdrawalBeforeSign({ db }, request);
  };
  signing.onExecuted = async (request) => {
    await settleApprovalAsks(db, request);
    await continueWalletSteps(ctx, request);
    // A spending-rule change that took a removed member off the policy
    // closes that offboarding to-do (Postgres only).
    const { resolveOffboardedSpenders } = await import('@/lib/server/spend-standing');
    await resolveOffboardedSpenders(db, request);
    if (request.purpose === 'withdrawal' || request.purpose === 'partner_payout' || request.purpose === 'partner_test_deposit') {
      // v2 §4.4: the withdrawal is sent and its digest posted to the partner,
      // or the test deposit is recorded for the partner to confirm.
      // The digest is posted only once the chain shows the intent the partner was instructed for.
      const [{ withdrawalSigningExecuted }, { withdrawalSettlementDeps }] = await Promise.all([import('@/lib/server/withdrawals'), import('@/lib/server/withdrawals-deps')]);
      const settlement = withdrawalSettlementDeps(db);
      if (settlement) await withdrawalSigningExecuted(settlement, request);
    }
    if (request.purpose === 'spend_policy') {
      // A new policy opened as part of reissuing the rules after a rotation
      // is followed by the reissue itself (§4.2).
      const { liveSpendContext } = await import('@/lib/server/spend-rules-deps');
      const { continueSpendSteps } = await import('@/lib/server/spend-rules');
      const spend = await liveSpendContext({ ctx, db, orgId: request.orgId });
      if (spend.ok) await continueSpendSteps(spend.sc, request);
    }
  };
  return { ok: true, ctx, db };
}

/** Every member of the org with every passkey they have (or none). */
async function memberPasskeyRows(db: DrizzleDb, orgId: string): Promise<PasskeyRow[]> {
  const people = await db.select({ userId: memberships.userId, role: memberships.role }).from(memberships).where(eq(memberships.orgId, orgId));
  const rows: PasskeyRow[] = [];
  for (const p of people) {
    const keys = await db
      .select({ publicKey: passkeyCredentials.publicKey, address: passkeyCredentials.suiAddress, rpId: passkeyCredentials.rpId, revokedAt: passkeyCredentials.revokedAt, createdAt: passkeyCredentials.createdAt })
      .from(passkeyCredentials)
      .where(eq(passkeyCredentials.userId, p.userId));
    if (keys.length === 0) rows.push({ userId: p.userId, role: String(p.role), publicKey: null, address: null, rpId: null, revokedAt: null, createdAt: null });
    for (const k of keys) rows.push({ userId: p.userId, role: String(p.role), ...k });
  }
  return rows;
}

/**
 * The org's owners (role admin) and the passkey each signs with on this
 * site, the founder being the BusinessAccount's on-chain owner; and the
 * owners who have no passkey here (lib/server/wallet-members.ts).
 */
export async function orgWalletMembers(db: DrizzleDb, orgId: string, account: AccountState) {
  return pickWalletMembers(await memberPasskeyRows(db, orgId), account, relyingPartyId());
}

/** Every address any member of the org has a passkey wallet at (for migration). */
export async function orgMemberWalletAddresses(db: DrizzleDb, orgId: string) {
  return memberWalletAddresses(await memberPasskeyRows(db, orgId), relyingPartyId());
}
