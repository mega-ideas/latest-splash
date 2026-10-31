/**
 * "How Splash operates", the plain-language card on Settings (v2 brief 5.9).
 * Each line is something Splash can say today: it holds no key to a business's
 * wallet and none of its funds, local-currency payouts are made by partners of
 * record, and Treasury is USDY in the business's own wallet. No licence is
 * claimed, no regulator's progress is reported, and nothing is called custody,
 * sweep or a stored balance (v2 decisions D9 and the copy rules).
 */
export const TREASURY_NOTE = 'USDY in your own Splash Wallet, from a tokenized treasury issuer, quoted on the Treasury page. Splash holds none of it. USDY is not Shariah-compliant.';

export const ABOUT: ReadonlyArray<{ label: string; text: string }> = [
  { label: 'Your wallet', text: 'Your USDC is held in your business wallet, which your owners sign for. Splash has no key to it and does not hold customer funds.' },
  { label: 'What Splash is', text: 'Splash is software that prepares payments for your owners to approve. Local-currency payouts are made by partners of record.' },
  { label: 'Treasury', text: TREASURY_NOTE },
  { label: 'Records and privacy', text: 'Each payment’s record is encrypted before it is stored, and its receipt links to it. Zeke remembers how you like to work, never balances or recipients.' },
  { label: 'Changes to Splash’s contract', text: 'Splash gives every owner 24 hours’ notice before a change to its payment contract or fees takes effect. Your own changes to rules, recipients and limits take effect at once.' },
];
