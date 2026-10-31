/**
 * The rails and standards Splash runs on, for the landing's partners strip
 * while no partner agreement is signed (v2 brief section 6). These are
 * networks and payment systems, not companies Splash has a contract with,
 * so naming them claims no partnership.
 *
 * The one file the copy guard lets name Walrus (scripts/copy-rules.mjs).
 */
export type Rail = { name: string; role: string };

export const LANDING_RAILS: readonly Rail[] = Object.freeze([
  { name: 'Sui', role: 'Where each payment settles' },
  { name: 'USDC', role: 'The one payment asset' },
  { name: 'Walrus', role: 'Where receipts are kept' },
  { name: 'InstaPay and PESONet', role: 'Philippine bank transfers' },
  { name: 'BI-FAST', role: 'Indonesian bank transfers' },
]);
