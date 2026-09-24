import { custodyPhaseEnabled, type CustodyConfig } from './custody-phase.ts';

/**
 * Where an invoice's payer is told to send the money, or null when Splash may
 * not collect it.
 *
 * These details are a Splash client account. A payer wiring into it is Splash
 * receiving and holding a third party's funds until it pays the issuer, which
 * is the Phase 2 custody capability (lib/server/custody-phase.ts). In Phase 0
 * the pay page shows no Splash account: the payer pays the issuer directly and
 * reports it on the page, so the issuer can match it.
 *
 * Before the custody package is configured, replace these with the real
 * collection account. The account number is a placeholder, and the Labuan
 * entity is the planned settlement perimeter (lib/server/labuan-settlement.ts).
 */
const SPLASH_COLLECTION_ACCOUNT = {
  beneficiary: 'Splash Labuan Ltd client account',
  bank: 'Maybank International Labuan Branch',
  account: 'CLIENT-USD-SETTLEMENT',
  swift: 'MBBEMYKL',
};

export type PayLinkBankInstructions = typeof SPLASH_COLLECTION_ACCOUNT;

export function payLinkBankInstructions(config?: CustodyConfig): PayLinkBankInstructions | null {
  return custodyPhaseEnabled(config) ? SPLASH_COLLECTION_ACCOUNT : null;
}
