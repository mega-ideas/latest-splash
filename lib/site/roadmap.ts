/**
 * The two milestones the brief locks (§0). Always both, exact strings;
 * every roadmap surface reads from here so nobody re-types a date.
 */
export const MILESTONES = [
  {
    id: 'mainnet',
    title: 'Mainnet publish',
    when: 'September 2026',
    note: 'protocol live, no customer funds',
    label: 'Mainnet publish · September 2026 (protocol live, no customer funds)',
    detail: 'splash_core and splash_meter publish on Sui mainnet. The package has no struct that can hold customer funds; settlement runs with sandbox counterparties until the first corridor activates.',
  },
  {
    id: 'first-corridor',
    title: 'First live corridor operations',
    when: 'October 2026',
    note: 'following MFCA activation',
    label: 'First live corridor operations · October 2026, following MFCA activation',
    detail: 'Philippines first, Indonesia after. A licensed payout partner sits at the far end of each corridor; Splash orchestrates and proves, the partner holds and pays out.',
  },
] as const;

/** Tiers that follow the milestones. Never a date, never a volume. */
export const AFTERWARDS = [
  { title: 'Money-broking tier', body: 'Labuan FSA money-broking application in progress. Lets Splash arrange, not hold.' },
  { title: 'Custody publishes', body: 'splash_custody goes on-chain only when the licence tier permits holding customer funds.' },
  { title: 'Treasury execution', body: 'The projected USDY position becomes executable once the e-money licence is granted. Variable, never a fixed rate.' },
] as const;
