/**
 * `not-licensed` exists because a regulatory position is not a model. The
 * Labuan claim carried status 'modeled', which reads as a product surface
 * that has been reasoned about rather than a fact about what a regulator has
 * granted. A reader can falsify this one against the Labuan FSA register,
 * which is what a status is for.
 */
export type ClaimStatus = 'live' | 'testnet-verified' | 'modeled' | 'simulated' | 'not-licensed';

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
  yield: 'Variable APY - T-bill-backed',
  agent: 'Zeke prepares. You approve.',
} as const;

export const claims = {
  heroSub: {
    claim: 'One operating account for cross-border invoices, FX, payouts, treasury and reconciliation - built for Southeast Asian businesses.',
    evidence: 'Product surfaces currently implemented in the app shell and v3 roadmap.',
    status: 'modeled',
  },
  labuanApplication: {
    claim: 'No licence held. A Labuan FSA money-broking application is in preparation with counsel.',
    evidence: 'Not on the Labuan FSA register — verifiable there. Preparation tracked in operating settings; SECURITY.md records the truth pass.',
    status: 'not-licensed',
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
    evidence: 'Treasury screen uses floating USDY source and labels projected/modelled values.',
    status: 'modeled',
  },
  receivable: {
    claim: 'Buyer-signed receivables and early-pay settlement are the v3 working-capital path.',
    evidence: 'Master build spec Phase C; UI is a modeled product surface until Move primitive ships.',
    status: 'modeled',
  },
  auditTrail: {
    claim: 'Settlement proofs are stored permanently and anchored on Sui when evidence is available.',
    evidence: 'Existing settlement evidence and audit batch routes.',
    status: 'testnet-verified',
  },
  footerLegal: {
    claim: 'Licence application in preparation with Labuan FSA. Not yet authorised to hold customer funds. Sandbox environment; no real money moves.',
    evidence: 'Current compliance posture from v3 truth pass.',
    status: 'modeled',
  },
} satisfies Record<string, Claim>;
