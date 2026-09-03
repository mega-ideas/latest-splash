import type { FundingSelection } from '@/lib/funding/registry';
import type { RecipientTier } from '@/lib/server/operations';

/**
 * Send flow state. One object flows through recipient → amount → review →
 * processing → receipt; nothing here is persisted in the browser.
 */
export type SendStep = 'recipient' | 'amount' | 'review' | 'processing' | 'receipt';

export const SEND_STEPS: SendStep[] = ['recipient', 'amount', 'review', 'processing', 'receipt'];

export type RecipientCountry = 'MY' | 'PH' | 'ID' | 'SG' | 'VN' | 'TH' | 'EU' | 'GB';
export type TargetCurrency = 'MYR' | 'PHP' | 'IDR' | 'SGD' | 'VND' | 'THB' | 'EUR' | 'GBP';

export const COUNTRY_TO_CURRENCY: Record<RecipientCountry, TargetCurrency> = {
  MY: 'MYR', PH: 'PHP', ID: 'IDR', SG: 'SGD', VN: 'VND', TH: 'THB', EU: 'EUR', GB: 'GBP',
};

export const COUNTRIES: Array<{ code: RecipientCountry; name: string }> = [
  { code: 'PH', name: 'Philippines' },
  { code: 'ID', name: 'Indonesia' },
  { code: 'MY', name: 'Malaysia' },
  { code: 'SG', name: 'Singapore' },
  { code: 'VN', name: 'Vietnam' },
  { code: 'TH', name: 'Thailand' },
  { code: 'EU', name: 'Eurozone' },
  { code: 'GB', name: 'United Kingdom' },
];

export type TransferState = {
  step: 1 | 2 | 3 | 4 | 5;
  invoiceId?: string;
  recipient: {
    name: string;
    country: RecipientCountry;
    rail: 'bank';
    bank?: { swift: string; account: string };
  };
  amount: { value: string; sourceCurrency: 'USD'; targetCurrency: TargetCurrency };
  quote?: { fxRate: number; netReceived: string; fee: string };
  funding: {
    selection: FundingSelection;
    sessionId?: string;
    sessionStatus?: string;
    depositAddress?: string;
    qrDataUrl?: string | null;
    demoMode?: boolean;
  };
  txDigest?: string;
  txStatus?: 'pending' | 'success' | 'failed';
  transferIntentId?: string;
  receiptObjectId?: string;
  paymentIntentId?: string;
  intentCreateDigest?: string;
  walrusBlobId?: string;
  auditAnchorId?: string;
  composedActions?: Array<{
    kind: 'paid' | 'allocated' | 'anchored';
    label: string;
    eventType: string;
    data: Record<string, unknown>;
  }>;
  deliveryTier: RecipientTier;
  rateHold?: {
    id: string;
    corridorCurrency: string;
    rate: string;
    feeBps: number;
    holdUntil: string;
    state: 'ACTIVE' | 'EXECUTED' | 'EXPIRED' | 'CANCELLED';
  };
};

export const initialTransferState: TransferState = {
  step: 1,
  recipient: { name: '', country: 'PH', rail: 'bank' },
  amount: { value: '', sourceCurrency: 'USD', targetCurrency: 'PHP' },
  deliveryTier: 'PAYOUT_ONLY',
  funding: {
    selection: { source: 'BANK_USD', type: 'fiat', provider: 'STRIPE', feeTier: 'STANDARD' },
  },
};

export function stepIndex(step: TransferState['step']): number {
  return step - 1;
}

export function fundingLabel(selection: FundingSelection): string {
  if (selection.type === 'held') return 'Splash balance';
  if (selection.type === 'fiat') return `Bank USD via ${selection.provider}`;
  return `${selection.asset} via ${selection.rail}${selection.sourceChain ? ` / ${selection.sourceChain}` : ''}`;
}

export const usd = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
