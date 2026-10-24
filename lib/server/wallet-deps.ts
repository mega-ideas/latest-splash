/**
 * The live wiring for the Business Splash Wallet: Postgres, the chain
 * (SUI_NETWORK's fullnode), the gas sponsor, WhatsApp, for ONE org.
 *
 * Fails closed. No database, no v2 object ids, or an org without its own
 * BusinessAccount id answers a refusal with the reason, never a stand-in: in
 * particular the account comes from `organizations.sui_business_account_id`
 * only, never from the single-tenant SPLASH_BUSINESS_ACCOUNT_ID fallback, so
 * one org's wallet transactions can never name another's account. A missing
 * sponsor is not a refusal here, because reading the inbox needs none; every
 * sponsored request is then refused when it would be opened (503).
 */
import 'server-only';

import { randomInt } from 'node:crypto';

import { and, eq, isNull } from 'drizzle-orm';
import { normalizeSuiAddress } from '@mysten/sui/utils';

import { relyingPartyId } from '@/lib/auth/passkey';
import { memberships, organizations, passkeyCredentials } from '@/lib/db/schema';
import { SUI_USDC_COIN_TYPE } from '@/lib/payments/stablecoin-lane';
import { listApprovers } from '@/lib/server/approver-channels';
import { walletSigningNotifier } from '@/lib/server/approval-requests';
import { continueWalletSteps, type WalletContext } from '@/lib/server/business-wallet';
import { v2ObjectIdsFromEnv, type SharedRef } from '@/lib/server/sui-v2-builders';
import type { SigningDeps, WalletChain } from '@/lib/server/wallet-signing';
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

function liveChain(): WalletChain {
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
  };
}

/** The USDC type wallet payments move: native USDC on this network (D6). */
export function walletUsdcType(env: NodeJS.ProcessEnv = process.env): string {
  return SUI_USDC_COIN_TYPE[(env.SUI_NETWORK ?? '').trim() === 'mainnet' ? 'mainnet' : 'testnet'];
}

/** Everything the wallet flows need for one org, or why it cannot run. */
export async function liveWalletContext(orgId: string): Promise<{ ok: true; ctx: WalletContext; db: DrizzleDb } | WalletDepsRefusal> {
  if (!process.env.DATABASE_URL) return { ok: false, status: 503, error: 'the business wallet needs the database, and DATABASE_URL is not set' };
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
    },
    notifier: walletSigningNotifier({ orgName: async () => org?.name ?? 'Your business', channels: listApprovers }),
  };
  const ctx: WalletContext = {
    signing,
    chain: { corePackageId: ids.ids.corePackageId, complianceConfig, feeConfig, registry, usdcType },
    account,
    validity: async () => {
      const { suiClient } = await import('@/lib/sui');
      const [{ systemState }, { chainIdentifier }] = await Promise.all([suiClient.core.getCurrentSystemState(), suiClient.core.getChainIdentifier()]);
      return { epoch: BigInt(systemState.epoch), chain: chainIdentifier, nonce: randomInt(0, 2 ** 32) };
    },
  };
  signing.onExecuted = async (request) => {
    await continueWalletSteps(ctx, request);
  };
  return { ok: true, ctx, db };
}

export type OwnerPasskey = { userId: string; publicKey: string; address: string; founder: boolean };

/**
 * The org's owners (role admin) and their active passkey on this origin.
 * The founder is the owner whose membership nobody granted (the first one).
 */
export async function orgOwnerPasskeys(db: DrizzleDb, orgId: string): Promise<OwnerPasskey[]> {
  const rows = await db
    .select({ userId: memberships.userId, grantedBy: memberships.grantedBy, publicKey: passkeyCredentials.publicKey, address: passkeyCredentials.suiAddress })
    .from(memberships)
    .innerJoin(
      passkeyCredentials,
      and(eq(passkeyCredentials.userId, memberships.userId), eq(passkeyCredentials.rpId, relyingPartyId()), isNull(passkeyCredentials.revokedAt)),
    )
    .where(and(eq(memberships.orgId, orgId), eq(memberships.role, 'admin')));
  return rows.map((r) => ({ userId: r.userId, publicKey: r.publicKey, address: normalizeSuiAddress(r.address), founder: r.grantedBy === null }));
}
