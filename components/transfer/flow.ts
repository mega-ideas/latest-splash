/** What the five steps share. Kept apart from the components so none imports another. */
import type { PayeeKind } from '@/lib/transfer/payee';
import type { Beneficiary, Context, SavedRecipient, SigningView } from './api';

export type Chosen =
  | { kind: 'bank'; beneficiaryId: string; name: string; country: string; currency: string; last4: string }
  | { kind: 'splash_business'; businessId: string; name: string; country: string | null }
  | { kind: 'recipient'; recipientId: string; name: string; deliveryKind: 'EXCHANGE' | 'SELF_CUSTODY' | 'CROSS_CHAIN'; address: string | null; blocked: string | null };

export type Flow = {
  step: 1 | 2 | 3 | 4 | 5;
  payeeType: PayeeKind | null;
  chosen: Chosen | null;
  amountText: string;
  purposeCode: string;
  sourceOfFunds: string;
  reference: string;
  intentKey: string;
};

export type Quote = {
  /** USDC minor units. */
  principalMinor: bigint;
  feeMinor: bigint;
  feesOn: boolean;
  /** Exactly the fee shown: sent back as max_fee. */
  maxFeeMinor: bigint;
  totalDebitMinor: bigint;
  kind: number;
  partnerFees: Array<{ partner: string; label: string; currency: string; amountMinor: string }>;
  receive: { currency: string; minor: string; rateMicro: string } | null;
  acceptedReceiveMinor: string | null;
  expiresAt: string | null;
  route: string | null;
  sandbox: boolean;
  /** Who is paid, as the quote read them: the full address and whether it was saved in the last 24 hours. Null for a bank payout. */
  payee: { address: string; country: string | null; recentlyAdded: boolean } | null;
};

/** The wallet balance as the page knows it: a number, or why there is none. */
export type Balance = { state: 'loading' } | { state: 'ok'; usdcMinor: bigint } | { state: 'none' | 'off' | 'unavailable' };

export type Made = {
  /** The id the receipt is read by. */
  ref: string;
  route: 'owners_sign' | 'asked_owners' | 'staff_rule';
  signing: SigningView | null;
  askId: string | null;
  /** What the server decided and why, in plain words: for a payment sent to the owners, the reasons it came to them. */
  plan?: { reasons: string[]; lines: string[] };
  /** A staff member's exchange payment: whether the Travel Rule message has gone to the provider, in words. */
  exchange?: { travelRule: { state: 'sent' | 'not_sent'; text: string }; /** A replayed send that confirmed another purpose: which purpose the exchange was already told. */ notice?: string };
  /** What the person approved on the Review step: the signing screen checks the transaction's bytes against it. */
  expected: { recipient: string | null; amountMinor: string; maxFeeMinor: string; payeeName: string } | null;
};

export type StepProps = {
  flow: Flow;
  patch: (change: Partial<Flow>) => void;
  ctx: Context | null;
  balance: Balance;
  recipients: SavedRecipient[];
  beneficiaries: Beneficiary[];
  reload: () => void;
  next: () => void;
  back: () => void;
};
