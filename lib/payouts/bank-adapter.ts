/**
 * The two halves every bank payout route has (v2 §4.5), so each partner is
 * a few facts and numbers rather than another copy of the same logic:
 *
 *   sandbox  outside production only. A deterministic deposit address per
 *            business that nobody holds a key to, a name enquiry that answers
 *            with the name given (an account number ending 0000 answers
 *            another company, so a mismatch can be exercised), a fixed
 *            sandbox rate and fixed sandbox fees, each its own line.
 *            Everything it returns says `sandbox: true`, and its webhooks
 *            are signed with the random sandbox secret only.
 *   live     production. Refuses without the partner's credentials
 *            (`partner_not_configured`), and with them (`partner_not_connected`)
 *            until the partner's API is wired from its contract. A guessed
 *            integration would fabricate a quote, a name check or a payout
 *            reference.
 *
 * Both check an instruction before anything is sent: a bank route, a
 * currency and country it pays, and an ISO 20022 message
 * (lib/payments/iso20022.ts) that names exactly the instruction's intent,
 * amount, account, holder and deposit.
 */

import { createHash, createHmac, randomBytes } from 'node:crypto';

import { blake2b } from '@noble/hashes/blake2.js';

import { assertPacs008Matches, Iso20022Error, localDecimals } from '../payments/iso20022.ts';
import type { PartnerId } from '../partners/signed-partners.ts';
import {
  sandboxWebhookSecretFor,
  PayoutPartnerUnavailable,
  verifyPayoutWebhook,
  WebhookRejected,
  type BankPayoutInstruction,
  type PartnerFeeLine,
  type PayoutInstruction,
  type PayoutPartner,
  type PayoutPartnerId,
  type PayoutQuote,
} from './partner.ts';

/** How long a quote holds. Past it, the rate is refused, never refreshed. */
export const PAYOUT_QUOTE_TTL_MS = 5 * 60 * 1000;

export type BankRouteFacts = {
  id: PayoutPartnerId;
  partners: readonly PartnerId[];
  countries: readonly string[];
  currencies: readonly string[];
};

/** Per process: a sandbox reference cannot be worked out from an intent id. */
const SANDBOX_KEY = randomBytes(32);

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

/** USDC minor (6 dp) at a rate in local per USDC ×1e6, to the local currency's minor units, rounded down. */
export function usdcToLocalMinor(usdcMinor: bigint, rateMicro: bigint, decimals: number): bigint {
  return (usdcMinor * rateMicro * 10n ** BigInt(decimals)) / 1_000_000_000_000n;
}

function assertCurrency(facts: BankRouteFacts, currency: string) {
  if (!facts.currencies.includes(currency)) throw new PayoutPartnerUnavailable(`This route pays ${facts.currencies.join(', ')} only.`, 'currency_not_offered');
}

/**
 * What every bank adapter checks before it tells a partner anything: the
 * instruction is a bank payout in a currency and country this route pays,
 * and its ISO 20022 message is this payout's.
 */
export function checkBankInstruction(facts: BankRouteFacts, input: PayoutInstruction): BankPayoutInstruction {
  if (input.route !== 'bank') throw new PayoutPartnerUnavailable('This route pays bank accounts only.', 'not_on_this_route');
  assertCurrency(facts, input.currency);
  if (!facts.countries.includes(input.beneficiary.country)) throw new PayoutPartnerUnavailable(`This route pays bank accounts in ${facts.countries.join(', ')} only.`, 'currency_not_offered');
  try {
    assertPacs008Matches(input.iso20022, input);
  } catch (error) {
    if (error instanceof Iso20022Error) throw new PayoutPartnerUnavailable(error.message, 'bad_instruction');
    throw error;
  }
  if (input.iso20022.CdtTrfTxInf.Purp.Cd !== input.purposeCode) throw new PayoutPartnerUnavailable('The purpose code differs between the instruction and its ISO 20022 data. Nothing was sent.', 'bad_instruction');
  return input;
}

export type SandboxBankSpec = {
  facts: BankRouteFacts;
  /** A short tag for the sandbox's own references (`hf`, `pdax`, `dp`). */
  tag: string;
  /** The seed the deterministic deposit address is hashed from. */
  depositSeed: string;
  /** The sandbox's rate, local per USDC ×1e6. Never a partner's. */
  rateMicro: bigint;
  /** The sandbox's fee lines on a gross local amount. Never a partner's. */
  fees: (grossMinor: bigint, currency: string) => PartnerFeeLine[];
  env: NodeJS.ProcessEnv;
};

export function sandboxBankAdapter(spec: SandboxBankSpec): PayoutPartner {
  const { facts, tag } = spec;
  return {
    ...facts,
    rail: 'bank',
    mode: 'sandbox',
    async depositAddress({ businessId }) {
      // Fixed per business; a hash, so nobody holds a key to it.
      const address = `0x${hex(blake2b(new TextEncoder().encode(`${spec.depositSeed}${businessId}`), { dkLen: 32 }))}`;
      const accountRef = `sbacct_${createHash('sha256').update(`${tag}:${businessId}`).digest('hex').slice(0, 24)}`;
      return { address, network: 'sui', accountRef, sandbox: true };
    },
    async checkAccount({ beneficiary }) {
      const number = beneficiary.accountNumber.replace(/[\s-]+/g, '');
      const holderName = number.endsWith('0000') ? 'Another Company Sdn Bhd' : beneficiary.holderName;
      const checkRef = `sbchk_${createHmac('sha256', SANDBOX_KEY).update(`${tag}:${beneficiary.bankCode}:${number}`).digest('hex').slice(0, 24)}`;
      return { holderName, checkRef, sandbox: true };
    },
    async quote({ currency, sendMinor, now }): Promise<PayoutQuote> {
      assertCurrency(facts, currency);
      const gross = usdcToLocalMinor(sendMinor, spec.rateMicro, localDecimals(currency));
      const lines = spec.fees(gross, currency);
      const receive = gross - lines.reduce((a, l) => a + l.amountMinor, 0n);
      const window = Math.floor(now.getTime() / PAYOUT_QUOTE_TTL_MS);
      const quoteRef = `sbq_${tag}_${createHmac('sha256', SANDBOX_KEY).update(`${tag}:${currency}:${sendMinor}:${window}`).digest('hex').slice(0, 24)}`;
      return {
        partner: facts.id,
        currency,
        sendMinor,
        rateMicro: spec.rateMicro,
        receiveMinor: receive > 0n ? receive : 0n,
        lines,
        quoteRef,
        expiresAt: new Date(now.getTime() + PAYOUT_QUOTE_TTL_MS),
        sandbox: true,
      };
    },
    async createPayout(input) {
      checkBankInstruction(facts, input);
      // Idempotent by the intent id: a retry names the same order.
      return { partnerRef: `sb_${tag}_${createHmac('sha256', SANDBOX_KEY).update(`${tag}:${input.intentId}`).digest('hex').slice(0, 24)}`, sandbox: true };
    },
    async postSettlement() {
      // The sandbox has nothing to tell.
    },
    async status() {
      return { status: 'instructed', sandbox: true };
    },
    handleWebhook({ rawBody, signature, now }) {
      return verifyPayoutWebhook(rawBody, signature, sandboxWebhookSecretFor(spec.env, facts.id), now);
    },
    async returnOrReverse() {
      return { accepted: true, sandbox: true };
    },
  };
}

export type LiveBankSpec = {
  facts: BankRouteFacts;
  /** Env names the partner's API needs. Every one must be set. */
  credentials: readonly string[];
  /** How the route is named in a refusal, by role, never by an unsigned partner's name ("our Philippines payout partner"). */
  who: string;
  env: NodeJS.ProcessEnv;
};

export function liveBankAdapter(spec: LiveBankSpec): PayoutPartner {
  const missing = spec.credentials.filter((k) => !(spec.env[k] ?? '').trim());
  const refuse = (): never => {
    if (missing.length > 0) {
      throw new PayoutPartnerUnavailable(`Payouts through ${spec.who} are not set up on this server (${missing.join(', ')} not set). Nothing was sent.`, 'partner_not_configured');
    }
    throw new PayoutPartnerUnavailable(`Payouts through ${spec.who} are not connected yet. Nothing was sent.`, 'partner_not_connected');
  };
  return {
    ...spec.facts,
    rail: 'bank',
    mode: 'live',
    depositAddress: async () => refuse(),
    checkAccount: async () => refuse(),
    quote: async () => refuse(),
    createPayout: async (input) => {
      // Unconfigured refuses first, whatever was sent. Configured, the
      // instruction is checked before the (not yet wired) partner call.
      if (missing.length === 0) checkBankInstruction(spec.facts, input);
      return refuse();
    },
    postSettlement: async () => refuse(),
    status: async () => refuse(),
    handleWebhook() {
      // No webhook is accepted until the API is wired: there is no live payout for one to move.
      try {
        return refuse();
      } catch (error) {
        throw new WebhookRejected((error as Error).message, (error as PayoutPartnerUnavailable).code);
      }
    },
    returnOrReverse: async () => refuse(),
  };
}
