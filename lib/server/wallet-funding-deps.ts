/**
 * The live wiring for funding the Business Splash Wallet (v2 §4.3), for ONE
 * org: the wallet context's database and BusinessAccount, the fullnode, the
 * screening provider, the signed-partner list. Built from a WalletRoute
 * (session-scoped, lib/server/wallet-route.ts) or, for a partner webhook,
 * from the org its verified event names.
 */
import 'server-only';

import { eq } from 'drizzle-orm';
import { normalizeStructTag, normalizeSuiAddress } from '@mysten/sui/utils';

import { kytProviderFromEnv } from '@/lib/compliance/kyt';
import { organizations } from '@/lib/db/schema';
import { parseSignedPartners } from '@/lib/partners/signed-partners';
import type { WalletContext } from '@/lib/server/business-wallet';
import { liveWalletContext, walletUsdcType } from '@/lib/server/wallet-deps';
import type { FundingChainTx, FundingDeps, Refusal } from '@/lib/server/wallet-funding';
import type { DrizzleDb } from '@/lib/server/wallet-signing-store';

function flagOn(value: string | undefined, fallback: boolean): boolean {
  const v = (value ?? '').trim().toLowerCase();
  return v === '' ? fallback : v === 'true';
}

async function readFundingTransaction(digest: string): Promise<FundingChainTx | null> {
  const { suiClient } = await import('@/lib/sui');
  let result;
  try {
    result = await suiClient.core.getTransaction({ digest, include: { effects: true, balanceChanges: true, transaction: true, events: true } });
  } catch (error) {
    if (/not ?found|does not exist|unknown/i.test(error instanceof Error ? error.message : '')) return null;
    throw error;
  }
  const t = (result.$kind === 'Transaction' ? result.Transaction : result.FailedTransaction) as unknown as {
    digest?: string;
    status: { success: boolean };
    balanceChanges?: Array<{ coinType: string; address: string; amount: string }>;
    transaction?: { sender?: string | null };
    events?: Array<{ packageId: string; eventType: string; json: Record<string, unknown> | null }>;
    timestampMs?: number | null;
  };
  return {
    digest: t.digest ?? digest,
    success: t.status.success,
    sender: t.transaction?.sender ?? null,
    timestampMs: t.timestampMs ?? null,
    balanceChanges: t.balanceChanges ?? [],
    events: (t.events ?? []).map((e) => ({ packageId: e.packageId, eventType: e.eventType, json: e.json })),
  };
}

export function fundingDepsFor(input: { orgId: string; ctx: WalletContext; db: DrizzleDb }, env: NodeJS.ProcessEnv = process.env): FundingDeps {
  const { orgId, ctx, db } = input;
  const splash = [env.OPERATOR_SUI_ADDRESS, env.TREASURY_ADDRESS, env.SPLASH_TEST_RECIPIENT_ADDRESS, ctx.signing.sponsor?.address]
    .filter((a): a is string => typeof a === 'string' && /^0x[0-9a-fA-F]{1,64}$/.test(a.trim()))
    .map((a) => normalizeSuiAddress(a.trim()));
  const usdt = flagOn(env.FUNDING_ASSET_USDT_ENABLED, false) && env.USDT_TYPE ? normalizeStructTag(env.USDT_TYPE) : null;
  const usdsui = flagOn(env.FUNDING_ASSET_USDSUI_ENABLED, true) && env.USDSUI_TYPE ? normalizeStructTag(env.USDSUI_TYPE) : null;
  return {
    db,
    orgId,
    env,
    now: () => new Date(),
    network: (env.SUI_NETWORK ?? '').trim().toLowerCase() === 'mainnet' ? 'mainnet' : 'testnet',
    readWallet: async () => (await ctx.readAccount()).wallet,
    readTransaction: readFundingTransaction,
    kyt: kytProviderFromEnv(env),
    companyName: async () => {
      const [org] = await db.select({ legalName: organizations.legalName, name: organizations.name }).from(organizations).where(eq(organizations.id, orgId)).limit(1);
      return (org?.legalName ?? org?.name ?? '').trim() || null;
    },
    coinTypes: { USDC: normalizeStructTag(walletUsdcType(env)), USDT: usdt, USDSUI: usdsui },
    splashAddresses: splash,
    signedPartners: parseSignedPartners(env.SIGNED_PARTNERS),
  };
}

/** For a partner webhook: the deps of the org its intent belongs to, or why there are none. */
export async function fundingDepsForOrg(orgId: string): Promise<FundingDeps | Refusal> {
  const live = await liveWalletContext(orgId);
  if (!live.ok) return { ok: false, status: live.status, code: 'wallet_unavailable', error: live.error };
  return fundingDepsFor({ orgId, ctx: live.ctx, db: live.db });
}
