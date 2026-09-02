export type ClaimStatus = 'live' | 'testnet-verified' | 'modeled' | 'simulated';

export type Claim = {
  claim: string;
  evidence: string;
  status: ClaimStatus;
};

export const lockedCopy = {
  headline: 'Collect USD. Pay Southeast Asia. Keep cash working.',
  fee: 'From 0.80% at the edge',
  feeFootnote: 'Starting fee; varies by corridor and volume.',
  speed: '~400ms Sui settlement finality',
  speedFootnote: 'Local delivery varies by rail.',
  // Treasury posture is a roadmap capability: projected, variable, never a live
  // offer and never a fixed figure. Goes live only when the e-money licence is granted.
  yield: 'Projected T-bill posture · roadmap',
  agent: '0xWal prepares. You approve.',
} as const;

export const claims = {
  heroSub: {
    claim: 'One operating account for cross-border invoices, FX, payouts, treasury and reconciliation - built for Southeast Asian businesses.',
    evidence: 'Product surfaces currently implemented in the app shell and v3 roadmap.',
    status: 'modeled',
  },
  labuanApplication: {
    claim: 'Labuan FSA licence application in progress.',
    evidence: 'Compliance status tracked in operating settings and SECURITY.md truth pass.',
    status: 'modeled',
  },
  sumsub: {
    claim: 'Sumsub KYB workflow is wired for business verification intake.',
    evidence: 'KYB upload and Sumsub route handlers in app/api/kyb.',
    status: 'testnet-verified',
  },
  elliptic: {
    claim: 'KYT and sanctions checks are part of the required production gate.',
    evidence: 'v3 compliance gate; provider wiring remains rollout work.',
    status: 'modeled',
  },
  custody: {
    claim: 'Qualified custody options are planned for international and Malaysia-local custody.',
    evidence: 'Key policy and v3 custody perimeter docs.',
    status: 'modeled',
  },
  finality: {
    claim: lockedCopy.speed,
    evidence: 'Sui settlement finality benchmark used as the settlement proof label.',
    status: 'testnet-verified',
  },
  fee: {
    claim: lockedCopy.fee,
    evidence: 'Corridor fee table in lib/fx/corridors.ts; exact fee varies by route and volume.',
    status: 'modeled',
  },
  treasuryYield: {
    claim: lockedCopy.yield,
    evidence: 'Treasury screen models a floating USDY posture; execution is gated until the e-money licence is granted.',
    status: 'modeled',
  },
  receivable: {
    claim: 'Buyer-signed receivables and early-pay settlement are the v3 working-capital path.',
    evidence: 'Master build spec Phase C; UI is a modeled product surface until Move primitive ships.',
    status: 'modeled',
  },
  auditTrail: {
    claim: 'Settlement proofs are stored on Walrus and anchored on Sui when evidence is available.',
    evidence: 'Existing settlement evidence and audit batch routes.',
    status: 'testnet-verified',
  },
  footerLegal: {
    claim: 'Splash Financial Labuan Ltd. Licence application in progress with Labuan FSA. Not yet authorised to hold customer funds. Sandbox environment - no real money moves.',
    evidence: 'Current compliance posture from v3 truth pass.',
    status: 'modeled',
  },
} satisfies Record<string, Claim>;
