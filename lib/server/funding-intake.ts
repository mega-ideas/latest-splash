import 'server-only';

import { timingSafeEqual } from 'node:crypto';

import { assessKyt, type FundingSourceType } from '@/lib/funding/kyt-policy';
import { resolveFundingSelection } from '@/lib/funding/registry';
import { recordMovement } from '@/lib/server/ledger-store';
import { normalizeToUsdc } from '@/lib/server/funding-normalization';
import {
  readFundingSession,
  registerSourceTransaction,
  updateFundingSession,
} from '@/lib/server/funding-sessions';

export type InboundDeposit = {
  sessionId: string;
  sourceTxDigest: string;
  receivedCoinType: string;
  destinationCoinType?: string;
  amountMicro: number;
  sourceType: FundingSourceType;
  riskScore: number;
  sanctionsMatch?: boolean;
  travelRuleOriginatorCaptured?: boolean;
  sourceOfFundsTraced?: boolean;
  cctpMessageStatus?: 'pending' | 'minted';
};

export function assertFundingWebhookSecret(value: string | null) {
  const expected = process.env.FUNDING_WEBHOOK_SECRET;
  if (!expected && (process.env.NODE_ENV !== 'production' || process.env.USE_MOCK_APIS === 'true' || process.env.NEXT_PUBLIC_DEMO_MODE === 'true')) return;
  if (!expected || !value) throw new Error('Funding webhook authentication failed');
  const expectedBuffer = Buffer.from(expected);
  const valueBuffer = Buffer.from(value);
  if (expectedBuffer.length !== valueBuffer.length || !timingSafeEqual(expectedBuffer, valueBuffer)) {
    throw new Error('Funding webhook authentication failed');
  }
}

function validateInboundAsset(input: InboundDeposit) {
  const session = readFundingSession(input.sessionId);
  if (!session) throw new Error('Funding session not found');
  if (session.selection.type !== 'stablecoin') throw new Error('This funding source does not accept stablecoin deposits');
  const { asset } = resolveFundingSelection(session.selection);
  if (!asset) throw new Error('Funding asset is unavailable');

  if (session.selection.rail === 'SUI_NATIVE') {
    if (!asset.coinType || input.receivedCoinType !== asset.coinType) {
      throw new Error(`Rejected non-canonical ${asset.symbol} coin type`);
    }
  } else {
    if (session.selection.asset !== 'USDC') throw new Error('CCTP only accepts USDC');
    if (input.cctpMessageStatus !== 'minted') throw new Error('CCTP message has not minted on Sui');
    if (!asset.coinType || input.destinationCoinType !== asset.coinType) {
      throw new Error('CCTP destination is not native Sui USDC');
    }
  }
  return { session, asset };
}

export async function ingestStablecoinDeposit(input: InboundDeposit) {
  const { session } = validateInboundAsset(input);
  if (session.selection.type !== 'stablecoin') throw new Error('Funding session is not stablecoin-funded');
  const selection = session.selection;
  if (!Number.isSafeInteger(input.amountMicro) || input.amountMicro <= 0) throw new Error('Deposit amount is invalid');
  if (session.status === 'QUARANTINED') throw new Error('Funding session is quarantined');
  if (session.status === 'CREDITED') return session;
  registerSourceTransaction(input.sourceTxDigest, session.id);

  const assessment = assessKyt({
    sourceType: input.sourceType,
    riskScore: input.riskScore,
    sanctionsMatch: input.sanctionsMatch,
    travelRuleOriginatorCaptured: input.travelRuleOriginatorCaptured,
    sourceOfFundsTraced: input.sourceOfFundsTraced,
    amountUsd: input.amountMicro / 1_000_000,
    selfCustodyStagedLimitUsd: Number(process.env.FUNDING_SELF_CUSTODY_STAGED_LIMIT_USD ?? '10000'),
  });

  updateFundingSession(session.id, {
    status: assessment.outcome,
    sourceType: input.sourceType,
    kytPolicy: assessment.policy,
    kytReasons: assessment.reasons,
    sourceTxDigest: input.sourceTxDigest,
    receivedCoinType: input.receivedCoinType,
    receivedAmountMicro: input.amountMicro,
    nativeSuiUsdc: selection.rail === 'CCTP' ? true : selection.asset === 'USDC',
    adminFlag: assessment.outcome === 'QUARANTINED' ? assessment.reasons.join('; ') : undefined,
  });
  if (assessment.outcome !== 'CLEARED') return readFundingSession(session.id)!;

  const normalized = await normalizeToUsdc(selection.asset, input.amountMicro);
  if (!normalized.success) {
    return updateFundingSession(session.id, {
      status: 'PENDING_CONVERT',
      adminFlag: normalized.reason,
    })!;
  }

  // The session's ORG, not its on-chain account id: that id falls back to a
  // value shared by every org without a provisioned account, so crediting by
  // it would put one tenant's deposit into another tenant's balance.
  await recordMovement({
    orgId: session.orgId,
    direction: 'CREDIT',
    amountMinor: BigInt(normalized.amountOutMicro),
    refType: 'FUNDING',
    refId: session.id,
    suiTxDigest: input.sourceTxDigest,
  });
  return updateFundingSession(session.id, {
    status: 'CREDITED',
    normalizedAmountUsdcMicro: normalized.amountOutMicro,
    normalizeVenue: normalized.venue,
    effectiveSlippageBps: normalized.effectiveSlippageBps,
    adminFlag: undefined,
  })!;
}

export function confirmUsdFunding(sessionId: string) {
  const session = readFundingSession(sessionId);
  if (!session) throw new Error('Funding session not found');
  if (session.selection.type !== 'fiat') throw new Error('Funding session is not a Bank USD funding session');
  resolveFundingSelection(session.selection);
  if (session.status === 'CREDITED') return session;
  const demoMode = process.env.NODE_ENV !== 'production'
    || process.env.USE_MOCK_APIS === 'true'
    || process.env.NEXT_PUBLIC_DEMO_MODE === 'true';
  if (!demoMode) throw new Error('USD provider confirmation is still pending');
  return updateFundingSession(session.id, {
    status: 'CREDITED',
    normalizedAmountUsdcMicro: session.amountExpectedMicro,
    normalizeVenue: 'PASSTHROUGH',
    effectiveSlippageBps: 0,
  })!;
}

export function confirmUsdProviderDeposit(input: {
  sessionId: string;
  provider: 'STRIPE' | 'AIRWALLEX';
  providerReference: string;
  amountMicro: number;
}) {
  const session = readFundingSession(input.sessionId);
  if (!session) throw new Error('Funding session not found');
  if (session.selection.type !== 'fiat' || session.selection.provider !== input.provider) {
    throw new Error('USD provider does not match the funding session');
  }
  if (session.amountExpectedMicro !== input.amountMicro) throw new Error('USD provider amount does not match the funding session');
  if (session.transferIntentId) throw new Error('Funding session is already bound to a transfer');
  return updateFundingSession(session.id, {
    status: 'CREDITED',
    sourceTxDigest: input.providerReference,
    normalizedAmountUsdcMicro: input.amountMicro,
    normalizeVenue: 'PASSTHROUGH',
    effectiveSlippageBps: 0,
  })!;
}
