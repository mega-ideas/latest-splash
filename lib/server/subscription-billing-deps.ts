/**
 * The live wiring for subscription billing (A1 §6; FEATURE_SUBSCRIPTION_BILLING,
 * off). Read-only chain queries; nothing here signs.
 *
 *   finance multisig  SPLASH_FINANCE_ADDRESS, and only while it is the
 *                     on-chain FeeConfig's fee recipient (fee_config proved
 *                     that address a multisig no single key can sign for
 *                     when it was proposed). Unset, malformed, or not the
 *                     fee recipient (including while Splash's fees are off):
 *                     no subscription is built.
 *   allowances        the AllowanceCap<Balance<USDC>>s a wallet owns and the
 *                     Allowances they point to, as the spending-rule index
 *                     reads them (lib/server/spend-rules-deps.ts).
 *   the pull's gas    the finance multisig's own address balance.
 */
import 'server-only';

import { randomInt } from 'node:crypto';

import { normalizeSuiAddress } from '@mysten/sui/utils';

import type { WalletContext } from '@/lib/server/business-wallet';
import type { BillingWallet, CycleDeps, HeldBillingAllowance } from '@/lib/server/subscription-billing';
import type { DrizzleDb } from '@/lib/server/wallet-signing-store';

/** The pull's gas budget: 0.05 SUI at most. */
const PULL_GAS_BUDGET_MIST = 50_000_000n;

async function reader(usdcType: string) {
  const [{ liveSpendReader }, { spendIdsFromEnv }] = await Promise.all([import('@/lib/server/spend-rules-deps'), import('@/lib/server/spend-rules-env')]);
  const ids = spendIdsFromEnv();
  // The package id only scopes SpendPolicy and RuleSpend reads, which billing
  // never makes; the allowance reads are the framework's.
  return liveSpendReader(ids.ok ? ids.spendPackageId : normalizeSuiAddress('0x0'), usdcType);
}

export async function liveFinanceAddress(env: NodeJS.ProcessEnv = process.env): Promise<{ ok: true; address: string } | { ok: false; error: string }> {
  const raw = (env.SPLASH_FINANCE_ADDRESS ?? '').trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(raw)) return { ok: false, error: 'SPLASH_FINANCE_ADDRESS is not set to the finance multisig, so no subscription is built' };
  const address = normalizeSuiAddress(raw);
  try {
    const { getFeeConfig } = await import('@/lib/fees/fee-config');
    const cfg = await getFeeConfig();
    if (cfg.feeRecipient !== address) return { ok: false, error: "SPLASH_FINANCE_ADDRESS is not FeeConfig's fee recipient on chain, so it is not a proven multisig and no subscription is built" };
  } catch {
    return { ok: false, error: 'the fee config could not be read, so the finance multisig cannot be checked' };
  }
  return { ok: true, address };
}

export function liveBillingWallet(ctx: WalletContext): BillingWallet {
  return {
    ctx,
    financeAddress: () => liveFinanceAddress(),
    readHeldAllowances: async (owner) => {
      const r = await reader(ctx.chain.usdcType);
      const caps = await r.listAllowanceCaps(owner);
      const allowances = await r.readAllowances(caps.map((c) => c.allowance));
      const byId = new Map(allowances.map((a) => [normalizeSuiAddress(a.id), a]));
      const out: HeldBillingAllowance[] = [];
      for (const c of caps) {
        const a = byId.get(normalizeSuiAddress(c.allowance));
        if (a) out.push({ ...a, cap: { objectId: normalizeSuiAddress(c.objectId), version: String(c.version), digest: c.digest } });
      }
      return out;
    },
  };
}

export async function liveCycleDeps(db: DrizzleDb): Promise<CycleDeps> {
  const [{ walletUsdcType, liveChain }, { suiClient }, { resolveEmailTransport }] = await Promise.all([
    import('@/lib/server/wallet-deps'),
    import('@/lib/sui'),
    import('@/lib/auth/email-transport'),
  ]);
  const usdcType = walletUsdcType();
  const chain = liveChain();
  return {
    db,
    usdcType,
    readAllowance: async (id) => {
      const r = await reader(usdcType);
      const [a] = await r.readAllowances([id]);
      return a ?? null;
    },
    financeGas: async () => {
      const [{ referenceGasPrice }, { systemState }, { chainIdentifier }] = await Promise.all([
        suiClient.core.getReferenceGasPrice(),
        suiClient.core.getCurrentSystemState(),
        suiClient.core.getChainIdentifier(),
      ]);
      return { price: BigInt(referenceGasPrice), budget: PULL_GAS_BUDGET_MIST, epoch: BigInt(systemState.epoch), chain: chainIdentifier, nonce: randomInt(0, 2 ** 32) };
    },
    readDigest: async (digest) => chain.read(digest),
    sendEmail: (m) => resolveEmailTransport().sendMessage(m),
  };
}
