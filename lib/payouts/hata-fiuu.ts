/**
 * `hata_fiuu`: Malaysia, the business's own bank (D4, v2 §4.4).
 *
 * The business wallet sends USDC to the business's fixed deposit address at
 * Hata (the exchange partner), Hata converts it to MYR, and Fiuu (the
 * bank-transfer partner) pays the MYR into the business's own bank account.
 * Splash never receives the MYR, and no Splash address is on the path.
 *
 * Sandbox (outside production only, lib/payouts/bank-adapter.ts): a
 * deterministic deposit address per business, a name enquiry that answers
 * with the name given (except for account numbers ending 0000), a fixed
 * sandbox rate and fixed sandbox fees.
 *
 * Live (production): refuses without HATA_API_KEY, HATA_WEBHOOK_SECRET,
 * FIUU_MERCHANT_ID and FIUU_VERIFY_KEY (`partner_not_configured`), and with
 * them (`partner_not_connected`) until both APIs are wired from their
 * contracts.
 */

import { liveBankAdapter, PAYOUT_QUOTE_TTL_MS, sandboxBankAdapter, usdcToLocalMinor, type BankRouteFacts } from './bank-adapter.ts';
import type { PayoutPartner } from './partner.ts';

export { PAYOUT_QUOTE_TTL_MS };

export const HATA_FIUU_CREDENTIALS = ['HATA_API_KEY', 'HATA_WEBHOOK_SECRET', 'FIUU_MERCHANT_ID', 'FIUU_VERIFY_KEY'] as const;

const FACTS: BankRouteFacts = { id: 'hata_fiuu', partners: ['hata', 'fiuu'], countries: ['MY'], currencies: ['MYR'] };

/** Sandbox numbers, never a partner's: 4.40 MYR per USDC, 0.10% exchange fee, RM1.00 bank transfer fee. */
const SANDBOX_RATE_MICRO = 4_400_000n;
const SANDBOX_EXCHANGE_FEE_BPS = 10n;
const SANDBOX_BANK_FEE_SEN = 100n;

/** USDC minor (6 dp) at a rate in local per USDC ×1e6, to sen (2 dp), rounded down. */
export function usdcToSen(usdcMinor: bigint, rateMicro: bigint): bigint {
  return usdcToLocalMinor(usdcMinor, rateMicro, 2);
}

export function hataFiuuAdapter(production: boolean, env: NodeJS.ProcessEnv): PayoutPartner {
  if (production) return liveBankAdapter({ facts: FACTS, credentials: HATA_FIUU_CREDENTIALS, who: 'our Malaysia withdrawal partners', env });
  return sandboxBankAdapter({
    facts: FACTS,
    tag: 'hf',
    depositSeed: 'splash:sandbox:hata-deposit:',
    rateMicro: SANDBOX_RATE_MICRO,
    fees: (gross, currency) => [
      { partner: 'hata', label: 'Exchange fee (sandbox)', currency, amountMinor: (gross * SANDBOX_EXCHANGE_FEE_BPS) / 10_000n },
      { partner: 'fiuu', label: 'Bank transfer fee (sandbox)', currency, amountMinor: SANDBOX_BANK_FEE_SEN },
    ],
    env,
  });
}
