import 'server-only';

import { createHash, createHmac, randomUUID } from 'node:crypto';

import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';

import {
  fundingMethodForSelection,
  resolveFundingSelection,
  type FundingFeeTier,
  type FundingSourceId,
  type FundingSelection,
  type StablecoinAssetSymbol,
  type StablecoinRail,
  type CctpSourceChain,
} from '@/lib/funding/registry';
import type { FundingSourceType } from '@/lib/funding/kyt-policy';

export type FundingSessionStatus =
  | 'AWAITING_DEPOSIT'
  | 'PENDING_KYT'
  | 'CLEARED'
  | 'PENDING_CONVERT'
  | 'QUARANTINED'
  | 'CREDITED';

export type FundingSession = {
  id: string;
  /** The tenant this deposit credits. The on-chain account id below is NOT a
   *  tenant key — it falls back to a value shared across orgs — so the ledger
   *  credit is keyed by this. */
  orgId: string;
  businessAccountId: string;
  selection: FundingSelection;
  feeTier: FundingFeeTier;
  amountExpectedMicro: number;
  depositAddress?: string;
  depositUri?: string;
  status: FundingSessionStatus;
  sourceType?: FundingSourceType;
  kytPolicy?: 'STANDARD' | 'ENHANCED';
  kytReasons?: string[];
  sourceTxDigest?: string;
  receivedCoinType?: string;
  receivedAmountMicro?: number;
  nativeSuiUsdc?: boolean;
  normalizedAmountUsdcMicro?: number;
  normalizeVenue?: 'CETUS' | 'AFTERMATH' | 'BLUEFIN' | 'PASSTHROUGH';
  effectiveSlippageBps?: number;
  transferIntentId?: string;
  adminFlag?: string;
  createdAt: string;
  updatedAt: string;
};

/**
 * The in-process fallback, used only when `DATABASE_URL` is not set so that
 * `npm run dev` works without a database. Every deployed environment reads
 * and writes `funding_sessions`, `funding_source_transactions` and
 * `funding_last_used_sources` instead (migration 0028). These maps were the
 * only store until WS8, and on serverless each instance had its own copy.
 */
type FundingSessionStore = {
  sessions: Map<string, FundingSession>;
  sourceTransactions: Map<string, string>;
  /** Keyed `<orgId>:<businessAccountId>`. */
  lastUsedSources: Map<string, FundingSourceId>;
};

const globalStore = globalThis as typeof globalThis & { splashFundingSessions?: FundingSessionStore };
const store = globalStore.splashFundingSessions ?? {
  sessions: new Map<string, FundingSession>(),
  sourceTransactions: new Map<string, string>(),
  lastUsedSources: new Map<string, FundingSourceId>(),
};
globalStore.splashFundingSessions = store;

let announced = false;

function usingPostgres(): boolean {
  if (process.env.DATABASE_URL) return true;
  if (!announced) {
    announced = true;
    console.warn(
      '[funding] DATABASE_URL is not set, so funding sessions live in this process ' +
        'and disappear when it restarts. Local development only.',
    );
  }
  return false;
}

async function db() {
  const { getDb } = await import('../db/client.ts');
  return getDb() as never;
}

async function repo() {
  return import('./repository/funding-sessions.ts');
}

function isDemoMode(env: NodeJS.ProcessEnv) {
  return env.NODE_ENV !== 'production' || env.USE_MOCK_APIS === 'true' || env.NEXT_PUBLIC_DEMO_MODE === 'true';
}

function deriveSuiAddress(businessAccountId: string, selection: FundingSelection, env: NodeJS.ProcessEnv) {
  const derivationSecret = env.FUNDING_DEPOSIT_DERIVATION_SECRET
    ?? (isDemoMode(env) ? 'splash-demo-deposit-derivation-only' : '');
  if (!derivationSecret) {
    throw new Error('FUNDING_DEPOSIT_DERIVATION_SECRET is required for per-business Sui deposit addresses');
  }
  const context = JSON.stringify({ businessAccountId, selection });
  const secretKey = createHmac('sha256', derivationSecret).update(context).digest();
  return Ed25519Keypair.fromSecretKey(secretKey).toSuiAddress();
}

function readConfiguredCctpAddress(
  businessAccountId: string,
  sourceChain: CctpSourceChain,
  env: NodeJS.ProcessEnv,
) {
  if (env.FUNDING_CCTP_DEPOSIT_ADDRESSES_JSON) {
    const parsed = JSON.parse(env.FUNDING_CCTP_DEPOSIT_ADDRESSES_JSON) as Record<string, Partial<Record<CctpSourceChain, string>>>;
    const address = parsed[businessAccountId]?.[sourceChain];
    if (address) return address;
  }
  if (!isDemoMode(env)) {
    throw new Error(`No CCTP ${sourceChain} deposit address is configured for this business account`);
  }

  const digest = createHash('sha256').update(`${businessAccountId}:${sourceChain}:demo`).digest('hex');
  return sourceChain === 'SOLANA' ? `DEMO_SOL_${digest.slice(0, 40)}` : `0x${digest.slice(0, 40)}`;
}

function stablecoinDepositAddress(
  businessAccountId: string,
  selection: Extract<FundingSelection, { type: 'stablecoin' }>,
  env: NodeJS.ProcessEnv,
) {
  if (selection.rail === 'SUI_NATIVE') return deriveSuiAddress(businessAccountId, selection, env);
  return readConfiguredCctpAddress(businessAccountId, selection.sourceChain!, env);
}

function depositUri(
  address: string,
  selection: Extract<FundingSelection, { type: 'stablecoin' }>,
  amountExpectedMicro: number,
) {
  const amount = (amountExpectedMicro / 1_000_000).toFixed(6);
  const params = new URLSearchParams({ asset: selection.asset, amount });
  if (selection.sourceChain) params.set('sourceChain', selection.sourceChain);
  const scheme = selection.rail === 'SUI_NATIVE'
    ? 'sui'
    : selection.sourceChain === 'SOLANA' ? 'solana' : 'ethereum';
  return `${scheme}:${address}?${params.toString()}`;
}

export async function createFundingSession(input: {
  orgId: string;
  businessAccountId: string;
  selection: FundingSelection;
  amountExpectedMicro: number;
}, env: NodeJS.ProcessEnv = process.env) {
  resolveFundingSelection(input.selection, env);
  if (input.selection.type === 'held') {
    throw new Error('Splash balance funding settles without a funding session');
  }
  if (!Number.isSafeInteger(input.amountExpectedMicro) || input.amountExpectedMicro <= 0) {
    throw new Error('Funding amount must be a positive integer in micro units');
  }

  const now = new Date().toISOString();
  const stablecoinSelection = input.selection.type === 'stablecoin' ? input.selection : null;
  const address = stablecoinSelection
    ? stablecoinDepositAddress(input.businessAccountId, stablecoinSelection, env)
    : undefined;
  const session: FundingSession = {
    id: `fund_${randomUUID()}`,
    orgId: input.orgId,
    businessAccountId: input.businessAccountId,
    selection: input.selection,
    feeTier: input.selection.feeTier,
    amountExpectedMicro: input.amountExpectedMicro,
    depositAddress: address,
    depositUri: address && stablecoinSelection
      ? depositUri(address, stablecoinSelection, input.amountExpectedMicro)
      : undefined,
    status: 'AWAITING_DEPOSIT',
    createdAt: now,
    updatedAt: now,
  };
  if (usingPostgres()) {
    await (await repo()).insertSession(await db(), session);
  } else {
    store.sessions.set(session.id, session);
  }
  await recordLastUsedFundingSource(input.orgId, input.businessAccountId, input.selection.source);
  return session;
}

export async function readFundingSession(sessionId: string) {
  if (!usingPostgres()) return store.sessions.get(sessionId) ?? null;
  return (await repo()).getSession(await db(), sessionId);
}

export async function listFundingSessions() {
  if (!usingPostgres()) {
    return [...store.sessions.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  return (await repo()).listSessions(await db());
}

export async function updateFundingSession(sessionId: string, patch: Partial<FundingSession>) {
  if (!usingPostgres()) {
    const session = store.sessions.get(sessionId) ?? null;
    if (!session) return null;
    // CREDITED is terminal for the status, as it is in the database store.
    if (session.status === 'CREDITED' && patch.status !== undefined && patch.status !== 'CREDITED') return null;
    Object.assign(session, patch, { updatedAt: new Date().toISOString() });
    store.sessions.set(sessionId, session);
    return session;
  }
  return (await repo()).patchSession(await db(), sessionId, patch);
}

/**
 * Assign an on-chain deposit to a session, once.
 *
 * The same session again is a retried webhook and passes. Another session is
 * the same deposit being credited twice, and throws — whichever instance it
 * reaches, and whichever of two simultaneous claims arrives second.
 */
export async function registerSourceTransaction(txDigest: string, sessionId: string) {
  if (!usingPostgres()) {
    const existing = store.sourceTransactions.get(txDigest);
    if (existing && existing !== sessionId) throw new Error('Source transaction was already assigned to another funding session');
    store.sourceTransactions.set(txDigest, sessionId);
    return;
  }
  const r = await repo();
  const database = await db();
  const session = await r.getSession(database, sessionId);
  if (!session) throw new Error('Funding session not found');
  const owner = await r.claimSourceTransaction(database, { txDigest, sessionId, orgId: session.orgId });
  if (owner !== sessionId) throw new Error('Source transaction was already assigned to another funding session');
}

/**
 * Credit a cleared deposit to the org's balance and mark the session CREDITED,
 * as one write.
 *
 * On Postgres the ledger journal and the status change commit in one
 * transaction, with the session row locked: a second credit of the same
 * session — a retried webhook, two at once — waits, then finds it CREDITED and
 * returns it without touching the ledger. Before this the credit and the
 * status were two writes, and a crash between them left money credited to a
 * session that still read CLEARED, ready to be credited again.
 */
export async function creditFundingSession(
  sessionId: string,
  credit: { amountMinor: bigint; suiTxDigest?: string; patch: Partial<FundingSession> },
): Promise<FundingSession> {
  if (!usingPostgres()) {
    const session = store.sessions.get(sessionId);
    if (!session) throw new Error('Funding session not found');
    if (session.status === 'CREDITED') return session;
    const { recordMovement } = await import('./ledger-store.ts');
    await recordMovement({
      orgId: session.orgId,
      direction: 'CREDIT',
      amountMinor: credit.amountMinor,
      refType: 'FUNDING',
      refId: session.id,
      suiTxDigest: credit.suiTxDigest,
    });
    return (await updateFundingSession(sessionId, { ...credit.patch, status: 'CREDITED' }))!;
  }
  const r = await repo();
  const { recordEntry } = await import('./repository/ledger.ts');
  const database = (await db()) as { transaction: <T>(run: (tx: never) => Promise<T>) => Promise<T> };
  return database.transaction(async (tx) => {
    const session = await r.getSessionForUpdate(tx, sessionId);
    if (!session) throw new Error('Funding session not found');
    if (session.status === 'CREDITED') return session;
    // The session's ORG, not its on-chain account id: that id falls back to a
    // value shared by every org without a provisioned account.
    await recordEntry(tx, {
      orgId: session.orgId,
      direction: 'CREDIT',
      amountMinor: credit.amountMinor,
      refType: 'FUNDING',
      refId: session.id,
      suiTxDigest: credit.suiTxDigest,
    });
    return (await r.patchSession(tx, sessionId, { ...credit.patch, status: 'CREDITED' }))!;
  });
}

/**
 * The funding source this org last paid with from this account.
 *
 * Keyed by org as well as account. The account id alone falls back to a value
 * shared by every org without a provisioned on-chain account, so keyed by it
 * one org's last choice was offered to another as its default.
 */
export async function readLastUsedFundingSource(orgId: string, businessAccountId: string) {
  if (!usingPostgres()) return store.lastUsedSources.get(`${orgId}:${businessAccountId}`) ?? null;
  return (await repo()).readLastUsedSource(await db(), orgId, businessAccountId);
}

export async function recordLastUsedFundingSource(orgId: string, businessAccountId: string, source: FundingSourceId) {
  if (!usingPostgres()) {
    store.lastUsedSources.set(`${orgId}:${businessAccountId}`, source);
    return;
  }
  await (await repo()).writeLastUsedSource(await db(), { orgId, businessAccountId, source });
}

export function assetDetails(session: FundingSession): {
  asset: StablecoinAssetSymbol;
  rail: StablecoinRail;
  sourceChain?: CctpSourceChain;
} | null {
  if (fundingMethodForSelection(session.selection) !== 'STABLECOIN') return null;
  if (session.selection.type !== 'stablecoin') return null;
  return {
    asset: session.selection.asset,
    rail: session.selection.rail,
    sourceChain: session.selection.sourceChain,
  };
}
