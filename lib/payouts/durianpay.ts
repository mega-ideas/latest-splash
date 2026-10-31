/**
 * `durianpay`: Indonesia (D4). USDC to IDR (through DurianPay's exchange
 * partner) to a bank account.
 *
 * The business wallet sends USDC to the business's fixed deposit address
 * with the Indonesia payout partner, in the owners' composed transaction.
 * Its exchange partner converts the USDC (to IDR, or IDRX and then IDR), and
 * the payout partner disburses the rupiah to the supplier's bank (BI-FAST).
 * The exchange partner's fee and the disbursement fee are two lines, never
 * marked up. Splash never receives the IDR and no Splash address is on the
 * path. IDR is paid in whole rupiah (0 decimal places).
 *
 * The exchange partner has no entry of its own in lib/partners: its fee is
 * quoted by DurianPay and shown as DurianPay's line, labelled as the exchange
 * partner's, until the agreement names the exchange.
 *
 * Sandbox (outside production only): lib/payouts/bank-adapter.ts, with a
 * fixed sandbox rate and two fixed sandbox fee lines. Never a partner's.
 *
 * Live (production): refuses without DURIANPAY_API_KEY,
 * DURIANPAY_WEBHOOK_SECRET and DURIANPAY_EXCHANGE_API_KEY
 * (`partner_not_configured`), and with them (`partner_not_connected`) until
 * both APIs are wired from the signed contracts.
 */

import { liveBankAdapter, sandboxBankAdapter, type BankRouteFacts } from './bank-adapter.ts';
import type { PayoutPartner } from './partner.ts';

export const DURIANPAY_CREDENTIALS = ['DURIANPAY_API_KEY', 'DURIANPAY_WEBHOOK_SECRET', 'DURIANPAY_EXCHANGE_API_KEY'] as const;

const FACTS: BankRouteFacts = { id: 'durianpay', partners: ['durianpay'], countries: ['ID'], currencies: ['IDR'] };

/** Sandbox numbers, never a partner's: 16,250 IDR per USDC, 0.15% exchange fee, Rp 4,000 disbursement fee. */
export const DURIANPAY_SANDBOX_RATE_MICRO = 16_250_000_000n;
const SANDBOX_EXCHANGE_FEE_BPS = 15n;
const SANDBOX_DISBURSEMENT_FEE_IDR = 4_000n;

export function durianpayAdapter(production: boolean, env: NodeJS.ProcessEnv): PayoutPartner {
  if (production) return liveBankAdapter({ facts: FACTS, credentials: DURIANPAY_CREDENTIALS, who: 'our Indonesia payout partner', env });
  return sandboxBankAdapter({
    facts: FACTS,
    tag: 'dp',
    depositSeed: 'splash:sandbox:durianpay-deposit:',
    rateMicro: DURIANPAY_SANDBOX_RATE_MICRO,
    fees: (gross, currency) => [
      { partner: 'durianpay', label: "Exchange partner's conversion fee (sandbox)", currency, amountMinor: (gross * SANDBOX_EXCHANGE_FEE_BPS) / 10_000n },
      { partner: 'durianpay', label: 'Disbursement fee (sandbox)', currency, amountMinor: SANDBOX_DISBURSEMENT_FEE_IDR },
    ],
    env,
  });
}
