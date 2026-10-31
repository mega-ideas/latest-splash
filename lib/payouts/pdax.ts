/**
 * `pdax`: the Philippines (D4). Stablecoin to PHP to a bank account.
 *
 * The business wallet sends USDC to the business's fixed deposit address at
 * the Philippines payout partner, in the owners' composed transaction. The
 * partner, told beforehand by API (intent id and expected amount), converts
 * it and pays the PHP into the supplier's bank account (InstaPay or PESONet).
 * The partner is the payer of record; Splash never receives the PHP and no
 * Splash address is on the path.
 *
 * Sandbox (outside production only): lib/payouts/bank-adapter.ts, with a
 * fixed sandbox rate and two fixed sandbox fee lines. Never PDAX's numbers.
 *
 * Live (production): refuses without PDAX_API_KEY, PDAX_API_SECRET and
 * PDAX_WEBHOOK_SECRET (`partner_not_configured`), and with them
 * (`partner_not_connected`) until the API is wired from the signed contract.
 */

import { liveBankAdapter, sandboxBankAdapter, type BankRouteFacts } from './bank-adapter.ts';
import type { PayoutPartner } from './partner.ts';

export const PDAX_CREDENTIALS = ['PDAX_API_KEY', 'PDAX_API_SECRET', 'PDAX_WEBHOOK_SECRET'] as const;

const FACTS: BankRouteFacts = { id: 'pdax', partners: ['pdax'], countries: ['PH'], currencies: ['PHP'] };

/** Sandbox numbers, never a partner's: 56.50 PHP per USDC, 0.20% conversion fee, ₱15.00 bank transfer fee. */
export const PDAX_SANDBOX_RATE_MICRO = 56_500_000n;
const SANDBOX_CONVERSION_FEE_BPS = 20n;
const SANDBOX_TRANSFER_FEE_CENTAVOS = 1_500n;

export function pdaxAdapter(production: boolean, env: NodeJS.ProcessEnv): PayoutPartner {
  if (production) return liveBankAdapter({ facts: FACTS, credentials: PDAX_CREDENTIALS, who: 'our Philippines payout partner', env });
  return sandboxBankAdapter({
    facts: FACTS,
    tag: 'pdax',
    depositSeed: 'splash:sandbox:pdax-deposit:',
    rateMicro: PDAX_SANDBOX_RATE_MICRO,
    fees: (gross, currency) => [
      { partner: 'pdax', label: 'Conversion fee (sandbox)', currency, amountMinor: (gross * SANDBOX_CONVERSION_FEE_BPS) / 10_000n },
      { partner: 'pdax', label: 'Bank transfer fee (sandbox)', currency, amountMinor: SANDBOX_TRANSFER_FEE_CENTAVOS },
    ],
    env,
  });
}
