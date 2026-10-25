/**
 * `hata_fiuu`: Malaysia, the business's own bank (D4, v2 §4.4).
 *
 * The business wallet sends USDC to the business's fixed deposit address at
 * Hata (the exchange partner), Hata converts it to MYR, and Fiuu (the
 * bank-transfer partner) pays the MYR into the business's own bank account.
 * Splash never receives the MYR, and no Splash address is on the path.
 *
 * Sandbox (outside production only): a deterministic deposit address per
 * business that nobody holds a key to, a name enquiry that answers with the
 * name given (except for account numbers ending 0000, which answer another
 * company, so a mismatch can be exercised), a fixed sandbox rate and fixed
 * sandbox fees. Everything it returns says `sandbox: true`.
 *
 * Live (production): refuses without HATA_API_KEY, HATA_WEBHOOK_SECRET,
 * FIUU_MERCHANT_ID and FIUU_VERIFY_KEY (`partner_not_configured`), and with
 * them (`partner_not_connected`) until both APIs are wired from their
 * contracts. A guessed integration would fabricate a quote, a name check or a
 * payout reference.
 */

import { createHash, createHmac, randomBytes } from 'node:crypto';

import { blake2b } from '@noble/hashes/blake2.js';

import {
  payoutSandboxWebhookSecret,
  PayoutPartnerUnavailable,
  verifyPayoutWebhook,
  WebhookRejected,
  type PayoutPartner,
  type PayoutQuote,
} from './partner.ts';

export const HATA_FIUU_CREDENTIALS = ['HATA_API_KEY', 'HATA_WEBHOOK_SECRET', 'FIUU_MERCHANT_ID', 'FIUU_VERIFY_KEY'] as const;

const FACTS = { id: 'hata_fiuu', partners: ['hata', 'fiuu'], countries: ['MY'], currencies: ['MYR'] } as const;

/** How long a quote holds. Past it, the rate is refused, never refreshed. */
export const PAYOUT_QUOTE_TTL_MS = 5 * 60 * 1000;

/** Sandbox numbers, never a partner's: 4.40 MYR per USDC, 0.10% exchange fee, RM1.00 bank transfer fee. */
const SANDBOX_RATE_MICRO = 4_400_000n;
const SANDBOX_EXCHANGE_FEE_BPS = 10n;
const SANDBOX_BANK_FEE_SEN = 100n;

/** Per process: a sandbox reference cannot be worked out from an intent id. */
const SANDBOX_KEY = randomBytes(32);

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

function assertMyr(currency: string) {
  if (currency !== 'MYR') throw new PayoutPartnerUnavailable('This route pays MYR only.', 'currency_not_offered');
}

/** USDC minor (6 dp) at a rate in local per USDC ×1e6, to sen (2 dp), rounded down. */
export function usdcToSen(usdcMinor: bigint, rateMicro: bigint): bigint {
  return (usdcMinor * rateMicro) / 10_000_000_000n;
}

function sandboxAdapter(env: NodeJS.ProcessEnv): PayoutPartner {
  return {
    ...FACTS,
    mode: 'sandbox',
    async depositAddress({ businessId }) {
      // Fixed per business; a hash, so nobody holds a key to it.
      const address = `0x${hex(blake2b(new TextEncoder().encode(`splash:sandbox:hata-deposit:${businessId}`), { dkLen: 32 }))}`;
      const accountRef = `sbacct_${createHash('sha256').update(`hata:${businessId}`).digest('hex').slice(0, 24)}`;
      return { address, network: 'sui', accountRef, sandbox: true };
    },
    async checkAccount({ beneficiary }) {
      const number = beneficiary.accountNumber.replace(/[\s-]+/g, '');
      const holderName = number.endsWith('0000') ? 'Another Company Sdn Bhd' : beneficiary.holderName;
      const checkRef = `sbchk_${createHmac('sha256', SANDBOX_KEY).update(`${beneficiary.bankCode}:${number}`).digest('hex').slice(0, 24)}`;
      return { holderName, checkRef, sandbox: true };
    },
    async quote({ currency, sendMinor, now }): Promise<PayoutQuote> {
      assertMyr(currency);
      const gross = usdcToSen(sendMinor, SANDBOX_RATE_MICRO);
      const exchangeFee = (gross * SANDBOX_EXCHANGE_FEE_BPS) / 10_000n;
      const receive = gross - exchangeFee - SANDBOX_BANK_FEE_SEN;
      const window = Math.floor(now.getTime() / PAYOUT_QUOTE_TTL_MS);
      const quoteRef = `sbq_hf_${createHmac('sha256', SANDBOX_KEY).update(`${sendMinor}:${window}`).digest('hex').slice(0, 24)}`;
      return {
        partner: 'hata_fiuu',
        currency,
        sendMinor,
        rateMicro: SANDBOX_RATE_MICRO,
        receiveMinor: receive > 0n ? receive : 0n,
        lines: [
          { partner: 'hata', label: 'Exchange fee (sandbox)', currency, amountMinor: exchangeFee },
          { partner: 'fiuu', label: 'Bank transfer fee (sandbox)', currency, amountMinor: SANDBOX_BANK_FEE_SEN },
        ],
        quoteRef,
        expiresAt: new Date(now.getTime() + PAYOUT_QUOTE_TTL_MS),
        sandbox: true,
      };
    },
    async createPayout({ intentId, currency }) {
      assertMyr(currency);
      return { partnerRef: `sb_hf_${createHmac('sha256', SANDBOX_KEY).update(intentId).digest('hex').slice(0, 24)}`, sandbox: true };
    },
    async postSettlement() {
      // The sandbox has nothing to tell.
    },
    async status() {
      return { status: 'instructed', sandbox: true };
    },
    verifyWebhook({ rawBody, signature, now }) {
      return verifyPayoutWebhook(rawBody, signature, payoutSandboxWebhookSecret(env), now);
    },
    async returnOrReverse() {
      return { accepted: true, sandbox: true };
    },
  };
}

function liveAdapter(env: NodeJS.ProcessEnv): PayoutPartner {
  const missing = HATA_FIUU_CREDENTIALS.filter((k) => !(env[k] ?? '').trim());
  const refuse = (): never => {
    if (missing.length > 0) {
      throw new PayoutPartnerUnavailable(`The Malaysia withdrawal partners are not set up on this server (${missing.join(', ')} not set). Nothing was sent.`, 'partner_not_configured');
    }
    throw new PayoutPartnerUnavailable('The Malaysia withdrawal partners are not connected yet. Nothing was sent.', 'partner_not_connected');
  };
  return {
    ...FACTS,
    mode: 'live',
    depositAddress: async () => refuse(),
    checkAccount: async () => refuse(),
    quote: async () => refuse(),
    createPayout: async () => refuse(),
    postSettlement: async () => refuse(),
    status: async () => refuse(),
    verifyWebhook() {
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

export function hataFiuuAdapter(production: boolean, env: NodeJS.ProcessEnv): PayoutPartner {
  return production ? liveAdapter(env) : sandboxAdapter(env);
}
