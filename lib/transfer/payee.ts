/**
 * Who a payment goes to, and what each kind needs (v2 brief 5.4, steps 1 and
 * 2; boards "Transfer · step 1"):
 *
 *   A business bank account    local currency in the supplier's bank. PHP and
 *                              IDR are live; MYR, VND, THB and SGD are under
 *                              Pilot access (the page offers "Request access",
 *                              never a quote, and never "coming soon").
 *   A business on Splash       USDC to another Splash business's wallet, found
 *                              by its registered name.
 *   A Sui wallet address       USDC to an address the business saved: an
 *                              exchange account, a wallet the supplier holds,
 *                              or USDC on another chain over CCTP V2.
 *
 * Splash's fee is the kind the chain derives from the destination
 * (lib/fees/destination.ts); this module only says which kind to ask the
 * schedule about. No fee number is written here (check:fees).
 *
 * Pure and client-safe.
 */
import { FEE_KIND, type FeeKind } from '../fees/schedule.ts';
import { CORRIDOR_RULES } from '../compliance/travel-rule.ts';

export const PAYEE_KINDS = ['bank', 'splash_business', 'wallet'] as const;
export type PayeeKind = (typeof PAYEE_KINDS)[number];

export const WALLET_PAYEE_KINDS = ['exchange', 'self_custody', 'cross_chain'] as const;
export type WalletPayeeKind = (typeof WALLET_PAYEE_KINDS)[number];

export type PayeeRef = { kind: PayeeKind; wallet?: WalletPayeeKind | string };

/** The first-step cards: what the board says, in the product's words. */
export const PAYEE_CARDS: Array<{ kind: PayeeKind; title: string; body: string; tags: string[] }> = [
  {
    kind: 'bank',
    title: 'A business bank account',
    body: 'Your supplier receives local currency in their bank. You pay in USDC.',
    tags: ['PHP', 'IDR'],
  },
  {
    kind: 'splash_business',
    title: 'A business on Splash',
    body: 'Find them by name. USDC lands in their Splash Wallet in seconds.',
    tags: ['USDC'],
  },
  {
    kind: 'wallet',
    title: 'A Sui wallet address',
    body: 'USDC to an exchange account, a wallet your supplier holds, or USDC on another chain. Final once sent.',
    tags: ['USDC'],
  },
];

export type CorridorAccess = 'live' | 'pilot' | 'unsupported';

export type BankCountry = { country: string; name: string; currency: string; access: Exclude<CorridorAccess, 'unsupported'>; rails: string };

/** Where a business bank account can be paid. PH and ID are live; the rest are under Pilot access. */
export const BANK_COUNTRIES: BankCountry[] = [
  { country: 'PH', name: 'Philippines', currency: 'PHP', access: 'live', rails: 'InstaPay or PESONet' },
  { country: 'ID', name: 'Indonesia', currency: 'IDR', access: 'live', rails: 'BI-FAST' },
  { country: 'MY', name: 'Malaysia', currency: 'MYR', access: 'pilot', rails: 'DuitNow' },
  { country: 'VN', name: 'Vietnam', currency: 'VND', access: 'pilot', rails: 'Napas' },
  { country: 'TH', name: 'Thailand', currency: 'THB', access: 'pilot', rails: 'PromptPay' },
  { country: 'SG', name: 'Singapore', currency: 'SGD', access: 'pilot', rails: 'FAST' },
];

export function corridorAccess(country: string): CorridorAccess {
  const found = BANK_COUNTRIES.find((c) => c.country === String(country ?? '').trim().toUpperCase());
  return found ? found.access : 'unsupported';
}

/**
 * The kind Splash's fee is charged as for what the person chose. It is the
 * kind the chain will derive for this destination, used to ask the schedule
 * what the payment costs before the quote comes back.
 */
export function feeKindOf(payee: PayeeRef): FeeKind {
  switch (payee.kind) {
    case 'bank':
      return FEE_KIND.BANK_PAYOUT;
    case 'splash_business':
      return FEE_KIND.SPLASH_BUSINESS;
    case 'wallet':
      if (payee.wallet === 'self_custody') return FEE_KIND.WALLET;
      if (payee.wallet === 'exchange') return FEE_KIND.EXCHANGE;
      if (payee.wallet === 'cross_chain') return FEE_KIND.CROSS_CHAIN;
      throw new RangeError('a wallet payee says whether it is an exchange account, a wallet the supplier holds, or another chain');
    default:
      throw new RangeError(`unknown payee kind: ${String((payee as { kind?: unknown }).kind)}`);
  }
}

export type PayeeField = 'account_number' | 'registered_name' | 'sui_address' | 'chain_address';

/** The one identifying field of each kind. A bank is never given a Sui address field, and a wallet never an account number. */
export function payeeFieldFor(payee: PayeeRef): PayeeField {
  switch (payee.kind) {
    case 'bank':
      return 'account_number';
    case 'splash_business':
      return 'registered_name';
    default:
      return payee.wallet === 'cross_chain' ? 'chain_address' : 'sui_address';
  }
}

export type Requirement = { label: string; because: string };
export type RequirementGroup = { heading: string; items: Requirement[] };
export type RequirementsSheet = { title: string; intro: string; groups: RequirementGroup[] };

/**
 * "What's needed for PH" (or ID): the sheet that replaces the long "Still
 * needed" list. One list, each thing once, each with why it is asked. Built
 * from the corridor rule (lib/compliance/travel-rule.ts) and from what the
 * supplier-account route stores (app/api/wallet/payouts/beneficiaries), so
 * the sheet cannot ask for something the payment will not use. A corridor
 * under Pilot access has no sheet: nothing is paid there yet.
 */
export function requirementsFor(country: string): RequirementsSheet | null {
  const code = String(country ?? '').trim().toUpperCase();
  if (corridorAccess(code) !== 'live') return null;
  const rule = CORRIDOR_RULES[code];
  const entry = BANK_COUNTRIES.find((c) => c.country === code);
  if (!rule || !entry) return null;
  return {
    title: `What’s needed for ${code}`,
    intro: `To pay a business bank account in ${entry.name} (${entry.currency}, by ${entry.rails}), the bank and its payout partner ask for these, once per supplier. Each is saved with the supplier, so the next payment asks for none of it.`,
    groups: [
      {
        heading: 'The supplier',
        items: [
          { label: 'Registered business name', because: 'It must be the name the bank holds on the account. The bank checks it before anything is saved, so a different spelling is found out now, not after the money has gone.' },
          { label: 'Company registration number', because: 'A payment to another business names the business it goes to, as the bank’s payout rules ask.' },
          { label: 'Registered address', because: 'Street, town and country, as a structured address: the payout partner passes it to the bank with the payment.' },
        ],
      },
      {
        heading: 'Their bank account',
        items: [
          { label: 'Bank', because: rule.note.split('. ')[0].replace(/\.$/, '') + '.' },
          { label: 'Account number', because: 'The local account number the payment is credited to. Only the last four digits are shown after it is saved.' },
        ],
      },
      {
        heading: 'About this payment',
        items: [
          { label: 'Purpose of payment', because: rule.note.split('. ').slice(1).join('. ').replace(/\.$/, '') + '.' },
          { label: 'Your relationship to the supplier', because: 'The bank asks whether the supplier is a supplier, a contractor, a customer or part of your group.' },
          { label: 'Where the money comes from', because: 'Payout banks ask where the money started. A line here means your payout is not held for questions later.' },
        ],
      },
    ],
  };
}
