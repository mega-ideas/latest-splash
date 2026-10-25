/**
 * Payout partners behind one interface (v2 §4.5, D4, D12): `hata_fiuu` (MY,
 * withdrawals to the business's own bank, §4.4), `pdax` (PH) and `durianpay`
 * (ID, with its exchange partner) for supplier payouts
 * (lib/server/partner-payouts.ts), and `cctp_wallet` (USDC to another chain
 * over CCTP V2). Every bank instruction carries its ISO 20022 message
 * (lib/payments/iso20022.ts), which the adapter checks before sending.
 *
 * The money model (D3, Sky's decision of 24 Oct 2026):
 *   - the partner gives each business ONE fixed Sui deposit address
 *     (`depositAddress`). Splash checks it is not an address Splash controls,
 *     the business's owners send it a small test deposit, and only when the
 *     partner confirms that deposit (a signed webhook naming the Sui digest,
 *     re-read on chain) is the address verified;
 *   - before any USDC moves, the payout instruction goes to the partner by
 *     API (`createPayout`), keyed by the intent id (the idempotency key) and
 *     the expected USDC amount, so the partner can match sender, amount and
 *     intent when the deposit lands;
 *   - the USDC goes from the business wallet straight to the partner's
 *     deposit address in the same transaction as the intent is opened, paid
 *     and anchored (the canonical composed PTB). There is no Splash-owned
 *     intermediate address;
 *   - after settlement Splash posts the Sui digest to the partner
 *     (`postSettlement`). The partner is the payer of record; Splash never
 *     receives the local currency.
 *
 * Fees: the partner's fees are the partner's, from its own quote, each shown
 * as its own line and never marked up. Splash's fee is computed on chain from
 * the derived kind (a bank payout, kind 4) and is not in these lines (A1).
 *
 * Every adapter has two implementations:
 *   sandbox  outside production only. Deterministic answers, labelled
 *            `sandbox: true`, webhooks signed with a random sandbox secret.
 *   live     production. Without the partner's credentials it refuses
 *            (`partner_not_configured`); with them it still refuses
 *            (`partner_not_connected`) until the partner's API is wired, so no
 *            quote, account-name check, deposit address or payout reference is
 *            ever fabricated. No sandbox answer is reachable in production.
 */

import { createHmac } from 'node:crypto';

import type { PartnerId } from '../partners/signed-partners.ts';
import type { Iso20022Party, Pacs008, PurposeCode } from '../payments/iso20022.ts';
import { verifySignedWebhook, WebhookRejected } from '../funding/providers.ts';

export { WebhookRejected };

/** Every payout route the brief names (§4.5). Each has a sandbox and a live adapter. */
export const PAYOUT_PARTNER_IDS = ['hata_fiuu', 'pdax', 'durianpay', 'cctp_wallet'] as const;
export type PayoutPartnerId = (typeof PAYOUT_PARTNER_IDS)[number];

export function isPayoutPartnerId(value: unknown): value is PayoutPartnerId {
  return typeof value === 'string' && (PAYOUT_PARTNER_IDS as readonly string[]).includes(value);
}

/** One fee line a partner charges, in the local currency's minor units. Never Splash's. */
export type PartnerFeeLine = {
  /**
   * Which partner charges it (named in copy only if signed), or `circle` for
   * CCTP's own fee, which Circle sets and takes at mint. Never Splash's.
   */
  partner: PartnerId | 'circle';
  label: string;
  currency: string;
  amountMinor: bigint;
};

/** A bank account as the partner will pay it. Held in memory only; the store keeps it encrypted. */
export type PayoutBeneficiary = {
  /** ISO 3166-1 alpha-2. */
  country: string;
  bankCode: string;
  accountNumber: string;
  holderName: string;
};

/** The partner's name enquiry: the holder name the bank itself has for the account. */
export type AccountNameCheck = {
  /** As the bank returned it. Compared with the business's registered name. */
  holderName: string;
  /** The partner's reference for the enquiry, kept as evidence. */
  checkRef: string;
  sandbox: boolean;
};

/** The partner's fixed deposit address for one business. */
export type PartnerDepositAddress = {
  /** A Sui address, normalized. */
  address: string;
  network: 'sui';
  /** The partner's own id for the business's account with it. */
  accountRef: string;
  sandbox: boolean;
};

export type PayoutQuote = {
  partner: PayoutPartnerId;
  currency: string;
  /** USDC (minor units, 6 decimals) the business sends the partner: the intent's principal. */
  sendMinor: bigint;
  /** Local currency per USDC, scaled by 1e6 (the intent's `fx_rate_usd_local`). */
  rateMicro: bigint;
  /** What the bank account receives, in the local currency's minor units, after the partner's fees. */
  receiveMinor: bigint;
  lines: PartnerFeeLine[];
  quoteRef: string;
  expiresAt: Date;
  sandbox: boolean;
};

/** What every instruction carries, whatever the route. */
type InstructionCommon = {
  /** The on-chain intent id: the idempotency key. */
  intentId: string;
  /** Exactly the USDC the deposit (or the burn) will carry: the intent's principal. */
  expectedUsdcMinor: bigint;
  quoteRef: string;
  currency: string;
  /** What the quote said the beneficiary receives. */
  receiveMinor: bigint;
  /**
   * The least the beneficiary must receive: what the owners accepted. The
   * partner converts when the deposit lands (the owners may sign up to
   * `settleByMs`, long after the quote); if its rate then pays less than
   * this, it does not pay out and returns the USDC to `returnAddress`.
   */
  minReceiveMinor: bigint;
  /** The deposit's deadline (the intent's settle_by, ms since epoch): none lands after it. */
  settleByMs: bigint;
  /** The business wallet the deposit comes from. */
  sourceWallet: string;
  /** Where a return goes: the business wallet, never Splash. */
  returnAddress: string;
  /** ISO 20022 ExternalPurpose1Code (INTC for a business moving its own money). */
  purposeCode: PurposeCode;
};

/**
 * A bank payout: what the partner is told before the deposit. Every field
 * comes from the stored payout; the beneficiary is the one whose commitment
 * the intent carries (`beneficiary_ref`), recomputed and compared before this
 * is sent, and `iso20022` is the pacs.008-style message built from the same
 * fields (lib/payments/iso20022.ts), which the adapter checks again.
 */
export type BankPayoutInstruction = InstructionCommon & {
  route: 'bank';
  beneficiary: PayoutBeneficiary;
  /** Hex of the 32-byte beneficiary commitment on the intent. */
  beneficiaryRef: string;
  /**
   * Hex of the commitment's salt, so the partner can recompute
   * `beneficiaryRef` from the account it pays and refuse an instruction that
   * does not match the intent on chain.
   */
  beneficiarySalt: string;
  /** The partner deposit address it goes to. */
  depositAddress: string;
  /** The quoted rate, local currency per USDC, in millionths (the message's XchgRate). */
  rateMicro: bigint;
  /** The paying business, as the message's Dbtr names it (the travel rule's originator half). */
  debtor: Iso20022Party;
  /** The partner's own fee lines from its quote (the message's ChrgsInf). */
  charges: PartnerFeeLine[];
  iso20022: Pacs008;
};

/**
 * A cross-chain USDC payout over CCTP V2 (`cctp_wallet`, D5(c)). There is no
 * partner deposit address: the owners' transaction burns exactly the
 * principal through Circle's TokenMessenger to `mintRecipient` on `domain`,
 * and anyone may relay the mint (destination caller zero).
 */
export type CrossChainPayoutInstruction = InstructionCommon & {
  route: 'cctp';
  destination: {
    /** The chain, as lib/payments/cctp.ts names it (e.g. BASE, SOLANA). */
    chain: string;
    domain: number;
    /** The recipient as its chain writes it. */
    recipient: string;
    /** CCTP's 32-byte mint recipient, hex. */
    mintRecipient: string;
  };
  /** The most Circle may take at mint (the intent's bridge_max_fee). */
  maxBridgeFeeMinor: bigint;
  minFinalityThreshold: number;
};

export type PayoutInstruction = BankPayoutInstruction | CrossChainPayoutInstruction;

export type PayoutOrder = { partnerRef: string; sandbox: boolean };

/** A payout's state at the partner, in the order it moves. */
export type PartnerPayoutStatus = 'instructed' | 'funds_received' | 'paid_out' | 'failed' | 'returned';

export type PayoutEvent =
  | {
      kind: 'payout';
      eventId: string;
      partnerRef: string;
      intentId: string;
      status: Exclude<PartnerPayoutStatus, 'instructed'>;
      /** The bank's reference on `paid_out` (Fiuu's transfer id). */
      bankRef?: string;
      /** The Sui transaction that returned the USDC, on `returned`. */
      returnDigest?: string;
      failureReason?: string;
      occurredAt: Date;
    }
  | {
      kind: 'test_deposit';
      eventId: string;
      /** The partner's account for the business, as `depositAddress` returned it. */
      accountRef: string;
      /** The Sui transaction the partner says it credited. */
      suiDigest: string;
      occurredAt: Date;
    };

/**
 * The partner's answer to `status`. A paid-out answer may carry the bank's
 * reference and a failed one the partner's reason, as a webhook would; both
 * are checked the same way (`partnerBankRef`, `partnerFailureReason`).
 */
export type PartnerStatusAnswer = { status: PartnerPayoutStatus; sandbox: boolean; bankRef?: string; failureReason?: string };

export class PayoutPartnerUnavailable extends Error {
  readonly code:
    | 'partner_not_configured'
    | 'partner_not_connected'
    | 'partner_disabled'
    | 'partner_not_built'
    | 'currency_not_offered'
    | 'not_on_this_route'
    | 'bad_instruction'
    /** The partner already holds another payout under this intent id. */
    | 'instruction_conflict'
    /** The partner holds no payout by this intent id and reference. */
    | 'payout_not_found';
  readonly status = 503;
  constructor(message: string, code: PayoutPartnerUnavailable['code']) {
    super(message);
    this.name = 'PayoutPartnerUnavailable';
    this.code = code;
  }
}

/**
 * One payout partner (v2 §4.5). The brief's five verbs are `quote`,
 * `createPayout`, `status`, `handleWebhook` and `returnOrReverse`; a bank
 * route also gives the business's fixed deposit address, checks an account's
 * holder name with the bank, and is told the Sui digest after settlement.
 */
export interface PayoutPartner {
  id: PayoutPartnerId;
  /** `bank`: USDC to the partner's deposit address, local currency to a bank. `cctp`: USDC burned on Sui, minted on another chain. */
  rail: 'bank' | 'cctp';
  /** The partners behind the route, for labels (named only when signed). */
  partners: readonly PartnerId[];
  countries: readonly string[];
  currencies: readonly string[];
  mode: 'sandbox' | 'live';
  /** The business's fixed deposit address with the partner (the same on every call). */
  depositAddress(input: { businessId: string; now: Date }): Promise<PartnerDepositAddress>;
  /** The bank's own holder name for an account (name enquiry). */
  checkAccount(input: { beneficiary: PayoutBeneficiary; now: Date }): Promise<AccountNameCheck>;
  /** `destinationChain` names the chain a cross-chain quote is for; bank routes ignore it. */
  quote(input: { currency: string; sendMinor: bigint; now: Date; destinationChain?: string }): Promise<PayoutQuote>;
  /** The instruction, before the deposit. Idempotent by `intentId`: a retry names the same order. */
  createPayout(input: PayoutInstruction & { now: Date }): Promise<PayoutOrder>;
  /** After settlement: the Sui digest of the deposit. */
  postSettlement(input: { intentId: string; partnerRef: string; suiDigest: string; now: Date }): Promise<void>;
  status(input: { intentId: string; partnerRef: string; now: Date }): Promise<PartnerStatusAnswer>;
  /** Verify a webhook's signature and freshness (signature first), then parse it. Throws WebhookRejected. */
  handleWebhook(input: { rawBody: string; signature: string | null; now: Date }): PayoutEvent;
  /**
   * Cancel an instruction no deposit followed, or ask for funds received to be
   * returned. A return goes to `returnAddress`, the business wallet.
   */
  returnOrReverse(input: { intentId: string; partnerRef: string; returnAddress: string; reason: string; now: Date }): Promise<{ accepted: boolean; sandbox: boolean }>;
}

// ─── Status order ───────────────────────────────────────────────────────────

const RANK: Record<PartnerPayoutStatus, number> = { instructed: 0, funds_received: 1, paid_out: 3, failed: 2, returned: 4 };

/**
 * Whether a partner's report may move a payout from `from` to `to`. Statuses
 * never go backwards: funds received → paid out; a failure (before payout) →
 * returned; funds received → returned (the partner did not pay out and sent
 * the USDC straight back). Paid out and returned are final.
 */
export function canAdvancePayout(from: PartnerPayoutStatus, to: PartnerPayoutStatus): boolean {
  if (from === to) return false;
  if (from === 'paid_out' || from === 'returned') return false;
  if (to === 'returned') return from === 'failed' || from === 'funds_received';
  if (to === 'failed') return from === 'instructed' || from === 'funds_received';
  if (to === 'paid_out') return from === 'instructed' || from === 'funds_received';
  return RANK[to] > RANK[from];
}

// ─── Webhooks: `t=<unix seconds>,v1=<hex hmac>` over `${t}.${body}` ─────────

/** The header a payout partner's webhook is signed in. */
export const PAYOUT_SIGNATURE_HEADER = 'x-splash-payout-signature';

const ID = /^[A-Za-z0-9_.:-]{6,128}$/;
const SUI_DIGEST = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const INTENT_ID = /^0x[0-9a-f]{64}$/;

/** A partner's bank reference, kept only when it is an id (the webhook's rule). */
export function partnerBankRef(v: unknown): string | undefined {
  return typeof v === 'string' && ID.test(v) ? v : undefined;
}

/** A partner's failure reason, cut to 200 characters (the webhook's rule). */
export function partnerFailureReason(v: unknown): string | undefined {
  const r = typeof v === 'string' ? v.slice(0, 200) : '';
  return r || undefined;
}

/** A field of an event Splash does not know, safe to keep and log: 64 characters of [A-Za-z0-9_.:-], the rest as '?'. */
function safeLabel(v: string): string {
  return v.slice(0, 64).replace(/[^A-Za-z0-9_.:-]/g, '?');
}

/**
 * A signed event whose type or status Splash does not know. It carries only
 * what ops need to find it (the event id, the type and the status, cut
 * short); nothing else from the body.
 */
export class UnknownPayoutEvent extends WebhookRejected {
  readonly eventId: string;
  readonly eventType: string;
  readonly eventStatus: string;
  constructor(message: string, e: { eventId: string; type: string; status: string }) {
    super(message, 'unknown_event');
    this.name = 'UnknownPayoutEvent';
    this.eventId = e.eventId;
    this.eventType = safeLabel(e.type);
    this.eventStatus = safeLabel(e.status);
  }
}

/** Parse a verified payout webhook body. Unknown events are refused, never guessed at. */
export function parsePayoutEvent(rawBody: string): PayoutEvent {
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    throw new WebhookRejected('The webhook body is not JSON.', 'bad_body');
  }
  const str = (k: string) => (typeof body[k] === 'string' ? (body[k] as string) : '');
  const eventId = str('eventId');
  if (!ID.test(eventId)) throw new WebhookRejected('The webhook has no event id.', 'bad_body');
  const at = new Date(str('occurredAt'));
  const occurredAt = Number.isNaN(at.getTime()) ? new Date(0) : at;
  if (str('type') === 'test_deposit.received') {
    const accountRef = str('accountRef');
    const suiDigest = str('suiDigest');
    if (!ID.test(accountRef) || !SUI_DIGEST.test(suiDigest)) throw new WebhookRejected('The test-deposit webhook is missing its account or digest.', 'bad_body');
    return { kind: 'test_deposit', eventId, accountRef, suiDigest, occurredAt };
  }
  const status = str('status');
  if (str('type') !== 'payout.status') throw new UnknownPayoutEvent('Unknown payout event.', { eventId, type: str('type'), status });
  if (!['funds_received', 'paid_out', 'failed', 'returned'].includes(status)) throw new UnknownPayoutEvent('Unknown payout status.', { eventId, type: str('type'), status });
  const partnerRef = str('partnerRef');
  const intentId = str('intentId').toLowerCase();
  if (!ID.test(partnerRef) || !INTENT_ID.test(intentId)) throw new WebhookRejected('The webhook is missing its payout or intent id.', 'bad_body');
  const returnDigest = str('returnDigest');
  if (status === 'returned' && !SUI_DIGEST.test(returnDigest)) throw new WebhookRejected('A return names the Sui transaction that returned the funds.', 'bad_body');
  const bankRef = partnerBankRef(body.bankRef);
  const failureReason = partnerFailureReason(body.failureReason);
  return {
    kind: 'payout',
    eventId,
    partnerRef,
    intentId,
    status: status as Exclude<PartnerPayoutStatus, 'instructed'>,
    ...(bankRef ? { bankRef } : {}),
    ...(returnDigest ? { returnDigest } : {}),
    ...(failureReason ? { failureReason } : {}),
    occurredAt,
  };
}

/** Verify (signature first, inside the replay window), then parse. */
export function verifyPayoutWebhook(rawBody: string, header: string | null, secret: string, now: Date): PayoutEvent {
  verifySignedWebhook(rawBody, header, secret, now);
  return parsePayoutEvent(rawBody);
}

/** The least length of the sandbox payout webhook secret: 32 characters, random. */
export const PAYOUT_SANDBOX_SECRET_MIN_LENGTH = 32;

/**
 * The sandbox payout partners' webhook secret, or '' (no sandbox webhook is
 * accepted): only when PAYOUT_SANDBOX_WEBHOOKS_ENABLED is true and
 * PAYOUT_SANDBOX_WEBHOOK_SECRET is at least 32 characters. No fallback.
 */
export function payoutSandboxWebhookSecret(env: NodeJS.ProcessEnv = process.env): string {
  if ((env.PAYOUT_SANDBOX_WEBHOOKS_ENABLED ?? '').trim().toLowerCase() !== 'true') return '';
  const secret = (env.PAYOUT_SANDBOX_WEBHOOK_SECRET ?? '').trim();
  return secret.length >= PAYOUT_SANDBOX_SECRET_MIN_LENGTH ? secret : '';
}

/**
 * One sandbox route's own webhook secret, derived from the configured one:
 * HMAC-SHA256(secret, "splash:payout-sandbox-webhook:v1:<partner>"), hex. A
 * body signed for one route does not verify at another, as with the live
 * routes' own secrets (PDAX_WEBHOOK_SECRET, DURIANPAY_WEBHOOK_SECRET,
 * HATA_WEBHOOK_SECRET). '' when no sandbox webhook is accepted.
 */
export function sandboxWebhookSecretFor(env: NodeJS.ProcessEnv, partner: PayoutPartnerId): string {
  const secret = payoutSandboxWebhookSecret(env);
  if (!secret) return '';
  return createHmac('sha256', secret).update(`splash:payout-sandbox-webhook:v1:${partner}`).digest('hex');
}
