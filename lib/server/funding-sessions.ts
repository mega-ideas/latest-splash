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

type FundingSessionStore = {
  sessions: Map<string, FundingSession>;
  sourceTransactions: Map<string, string>;
  lastUsedSources: Map<string, FundingSourceId>;
};

const globalStore = globalThis as typeof globalThis & { splashFundingSessions?: FundingSessionStore };
const store = globalStore.splashFundingSessions ?? {
  sessions: new Map<string, FundingSession>(),
  sourceTransactions: new Map<string, string>(),
  lastUsedSources: new Map<string, FundingSourceId>(),
};
globalStore.splashFundingSessions = store;

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

export function createFundingSession(input: {
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
  store.sessions.set(session.id, session);
  recordLastUsedFundingSource(input.businessAccountId, input.selection.source);
  return session;
}

export function readFundingSession(sessionId: string) {
  return store.sessions.get(sessionId) ?? null;
}

export function listFundingSessions() {
  return [...store.sessions.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function updateFundingSession(sessionId: string, patch: Partial<FundingSession>) {
  const session = readFundingSession(sessionId);
  if (!session) return null;
  Object.assign(session, patch, { updatedAt: new Date().toISOString() });
  store.sessions.set(sessionId, session);
  return session;
}

export function registerSourceTransaction(txDigest: string, sessionId: string) {
  const existing = store.sourceTransactions.get(txDigest);
  if (existing && existing !== sessionId) throw new Error('Source transaction was already assigned to another funding session');
  store.sourceTransactions.set(txDigest, sessionId);
}

export function readLastUsedFundingSource(businessAccountId: string) {
  return store.lastUsedSources.get(businessAccountId) ?? null;
}

export function recordLastUsedFundingSource(businessAccountId: string, source: FundingSourceId) {
  store.lastUsedSources.set(businessAccountId, source);
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
