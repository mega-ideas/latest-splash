/**
 * The live wiring for Transfer (v2 brief 5.4), for ONE org: the wallet
 * route's gate (a signed-in customer, the org from the SESSION through
 * requireSessionAccount, their own membership, the org's live wallet context),
 * then the chain, Splash's fee, Seal and Walrus, the saved recipients and
 * other Splash businesses. Nothing here reads an org, an account, a wallet or
 * a fee from the request.
 */
import 'server-only';

import { and, eq, ilike, isNotNull, ne, or } from 'drizzle-orm';
import { normalizeSuiAddress } from '@mysten/sui/utils';

import { organizations } from '@/lib/db/schema';
import { parseSignedPartners } from '@/lib/partners/signed-partners';
import { corePackageOriginalIdFor } from '@/lib/payouts/withdrawal-rules';
import { currentWalletMembers } from '@/lib/server/business-wallet';
import { exchangeAloneOf } from '@/lib/server/exchange-alone';
import { makePaymentRecorder } from '@/lib/server/payment-record';
import { sealAdapter } from '@/lib/server/seal';
import { splashControlledAddresses } from '@/lib/payouts/withdrawal-rules';
import type { TransferDeps } from '@/lib/server/wallet-transfers';
import type { BatchDeps } from '@/lib/server/wallet-batches';
import { liveWalletContext, orgMemberWalletAddresses } from '@/lib/server/wallet-deps';
import { NO_STORE, walletRoute, type WalletRoute } from '@/lib/server/wallet-route';
import { readWithdrawalTransaction } from '@/lib/server/withdrawals-deps';
import { isAnotherBusinessWallet } from '@/lib/server/withdrawals-store';
import { storeEncryptedInvoice } from '@/lib/server/walrus';
import type { ReceiptDeps } from '@/lib/server/payment-receipts';

function likePattern(query: string): string {
  return `${query.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/** What the wiring needs of a route: the business, its wallet context and the database. The cron makes one without a signed-in person. */
export type WalletRouteLike = Pick<WalletRoute, 'orgId' | 'ctx' | 'db'>;

export function transferDepsFor(route: WalletRouteLike, env: NodeJS.ProcessEnv = process.env): TransferDeps {
  const { orgId, ctx, db } = route;
  return {
    db,
    orgId,
    env,
    now: () => new Date(),
    ctx,
    walletMembers: async () => {
      const current = await currentWalletMembers(ctx, db, orgId);
      return current.ok ? { ok: true, address: current.address, members: current.members } : { ok: false, status: current.status, code: current.code, error: current.error };
    },
    splashAddresses: async () => {
      const { getFeeConfig } = await import('@/lib/fees/fee-config');
      const { splashCrossChainAddresses } = await import('@/lib/server/splash-addresses');
      return splashControlledAddresses({ env, sponsor: ctx.signing.sponsor?.address ?? null, feeConfig: await getFeeConfig(), extra: splashCrossChainAddresses(env) });
    },
    isBusinessWallet: (address) => isAnotherBusinessWallet(db, orgId, normalizeSuiAddress(address)),
    // A business is found by id from the search below; its wallet is what ITS BusinessAccount names on chain.
    businessWallet: async (businessId) => {
      const [org] = await db
        .select({ id: organizations.id, name: organizations.name, legalName: organizations.legalName, country: organizations.addressCountry, lifecycle: organizations.kybLifecycle, account: organizations.suiBusinessAccountId })
        .from(organizations)
        .where(and(eq(organizations.id, businessId), isNotNull(organizations.suiBusinessAccountId)))
        .limit(1);
      if (!org || org.lifecycle !== 'ACTIVE') return null;
      const live = await liveWalletContext(org.id);
      if (!live.ok) return null;
      try {
        const account = await live.ctx.readAccount();
        return account.wallet ? { ok: true, name: org.legalName || org.name, wallet: normalizeSuiAddress(account.wallet), country: org.country } : null;
      } catch {
        return null;
      }
    },
    // Registered names only, a prefix, at least three letters (the caller checks), five at most. Businesses that have finished KYB and have an account on chain.
    searchBusinesses: async (query) => {
      const pattern = likePattern(query);
      const rows = await db
        .select({ id: organizations.id, name: organizations.name, legalName: organizations.legalName, country: organizations.addressCountry })
        .from(organizations)
        .where(and(isNotNull(organizations.suiBusinessAccountId), eq(organizations.kybLifecycle, 'ACTIVE'), ne(organizations.id, orgId), or(ilike(organizations.legalName, pattern), ilike(organizations.name, pattern))))
        .limit(5);
      return rows.map((r) => ({ id: r.id, name: r.legalName || r.name, country: r.country }));
    },
    splashFee: async ({ kind, principalMinor }) => {
      const { currentSplashFee } = await import('@/lib/fees/fee-config');
      const fee = await currentSplashFee({ businessId: normalizeSuiAddress(ctx.account.objectId), kind: kind as 0 | 1 | 2 | 3 | 4, principalMinor });
      return { feeMinor: fee.feeMinor, feesOn: fee.feesOn };
    },
    paymentRecord: makePaymentRecorder({ seal: sealAdapter, store: storeEncryptedInvoice, env }),
    requesterAddresses: async (userId) => (await orgMemberWalletAddresses(db, orgId)).filter((a) => a.userId === userId).map((a) => a.address),
    askPolicy: async () => {
      const { liveSpendContext } = await import('@/lib/server/spend-rules-deps');
      const { readCurrentPolicy } = await import('@/lib/server/spend-rules');
      const live = await liveSpendContext(route);
      return live.ok ? readCurrentPolicy(live.sc) : null;
    },
    notifyAsk: async ({ ask, ownerUserIds, financeLeadUserId }) => {
      // The ladder: every owner is told in the app and by e-mail at once, and again if nobody answers (lib/server/approval-wait.ts). Never throws.
      const { tellApproversNow } = await import('@/lib/server/approval-wait');
      await tellApproversNow(db, { orgId, kind: 'ask', id: ask.id });
      const { notifyOwnersOfAsk } = await import('@/lib/server/approval-requests');
      const [org] = await db.select({ name: organizations.name }).from(organizations).where(eq(organizations.id, orgId)).limit(1);
      await notifyOwnersOfAsk({ orgId, orgName: org?.name ?? 'Your business', ownerUserIds, financeLeadUserId: financeLeadUserId ?? null, amountMinor: ask.intent.amountMinor, recipient: ask.intent.recipient });
    },
    // A payment under a staff rule (v2 §4.2): the chain client for this business's rules, and the person's own passkey that can sign here.
    spend: async () => {
      const { liveSpendContext } = await import('@/lib/server/spend-rules-deps');
      const live = await liveSpendContext(route);
      return live.ok ? live.sc : null;
    },
    staffSigner: async (userId) => {
      const mine = (await orgMemberWalletAddresses(db, orgId)).find((m) => m.userId === userId && m.canSign);
      return mine ? { publicKey: mine.publicKey, address: mine.address } : null;
    },
    // An owner's switch, read from the database each time (lib/server/exchange-alone.ts): default deny.
    payExchangeAlone: (userId) => exchangeAloneOf(db, orgId, userId),
  };
}

/**
 * The live wiring for batch payouts (v2 brief 5.6): Transfer's, plus what the
 * wallet can spend now (its balance less held deposits) and a note to the
 * owners when a team member prepares a batch.
 */
export function batchDepsFor(route: WalletRouteLike, env: NodeJS.ProcessEnv = process.env): BatchDeps {
  const base = transferDepsFor(route, env);
  const { orgId, ctx, db } = route;
  return {
    ...base,
    walletBalance: async () => {
      const members = await base.walletMembers();
      if (!members.ok || !ctx.readUsdc) return null;
      const read = await ctx.readUsdc(members.address);
      const total = read.coinMinor + read.addressBalanceMinor;
      const held = ctx.heldUsdc ? await ctx.heldUsdc(members.address, total) : 0n;
      return total > held ? total - held : 0n;
    },
    notifyBatch: async ({ rowCount, totalMinor, requestedBy }) => {
      const { memberships } = await import('@/lib/db/schema');
      const { notifyOwnersOfBatch } = await import('@/lib/server/approval-requests');
      const owners = await db.select({ userId: memberships.userId }).from(memberships).where(and(eq(memberships.orgId, orgId), eq(memberships.role, 'admin')));
      const [org] = await db.select({ name: organizations.name }).from(organizations).where(eq(organizations.id, orgId)).limit(1);
      await notifyOwnersOfBatch({ orgId, orgName: org?.name ?? 'Your business', ownerUserIds: owners.map((o) => o.userId).filter((u) => u !== requestedBy), rowCount, totalMinor: totalMinor.toString() });
    },
  };
}

export async function batchRoute(request: Request): Promise<{ route: WalletRoute; deps: BatchDeps; response: null } | { route: null; deps: null; response: Response }> {
  const gate = await walletRoute(request);
  if (gate.response) return { route: null, deps: null, response: gate.response };
  return { route: gate.route, deps: batchDepsFor(gate.route), response: null };
}

export async function transferRoute(request: Request): Promise<{ route: WalletRoute; deps: TransferDeps; response: null } | { route: null; deps: null; response: Response }> {
  const gate = await walletRoute(request);
  if (gate.response) return { route: null, deps: null, response: gate.response };
  return { route: gate.route, deps: transferDepsFor(gate.route), response: null };
}

/** What a receipt reads for one org: the chain, the fee schedule in force, who is signed. */
export async function receiptDepsFor(db: WalletRoute['db'], orgId: string, env: NodeJS.ProcessEnv = process.env): Promise<ReceiptDeps> {
  let schedule: ReceiptDeps['schedule'] = null;
  let feesOn: boolean | null = null;
  try {
    const { getFeeConfig } = await import('@/lib/fees/fee-config');
    const config = await getFeeConfig();
    schedule = config.schedule;
    feesOn = config.feesOn;
  } catch {
    /* the receipt then shows no tier and assumes fees are on */
  }
  return {
    db,
    orgId,
    now: () => new Date(),
    readTransaction: readWithdrawalTransaction,
    corePackageOriginalId: corePackageOriginalIdFor(env),
    env,
    schedule,
    feesOn,
    signedPartners: [...parseSignedPartners(env.SIGNED_PARTNERS)],
    network: (env.SUI_NETWORK ?? '').trim() === 'mainnet' ? 'mainnet' : 'testnet',
  };
}

export { NO_STORE };
