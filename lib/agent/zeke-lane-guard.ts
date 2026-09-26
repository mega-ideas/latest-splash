import type { KybLifecycleState } from '../compliance/kyb-state.ts';
import { CUSTODY_PHASE_WHY } from '../custody-phase-rules.ts';
import { laneAccess, type Lane } from '../payments/stablecoin-lane.ts';
import { custodyPhaseEnabled } from '../server/custody-phase.ts';
import { kindInScope, launchScope, laneInScope, LAUNCH_SCOPE_REASON } from '../server/launch-scope.ts';

/**
 * What Zeke may prepare for a business, given how far through verification it
 * is — and the words it says when the answer is no.
 *
 * A business still in onboarding can send USDC on Sui to wallet recipients it
 * has saved (lib/payments/stablecoin-lane.ts). It cannot bring USD in, pay out
 * in a local currency, convert USD into one, or use Treasury. Zeke refuses
 * those at TWO points, because either alone leaves a gap:
 *
 *   1. The message, before any model sees it. "Pay Maria 50,000 pesos" is
 *      refused in words the operator can act on, with no model in the loop
 *      to soften or misstate the rule.
 *   2. Every propose tool. "Pay invoice inv_123" never names a currency — the
 *      invoice does, and the tool reads it. The model can also phrase a
 *      request no pattern anticipated. The tool is the backstop for both.
 *
 * Neither is the enforcement of record: the money routes are
 * (lib/server/kyb-gate.ts). Zeke refusing is the operator hearing "no" at the
 * start of the conversation instead of at the authorize button.
 */

export class ZekeLaneRefusal extends Error {
  readonly code = 'LANE_LOCKED';
  readonly lane: Lane;
  /** Null when the refusal is the launch scope, which no verification changes. */
  readonly state: KybLifecycleState | null;

  constructor(lane: Lane, state: KybLifecycleState | null, message: string) {
    super(message);
    this.name = 'ZekeLaneRefusal';
    this.lane = lane;
    this.state = state;
  }
}

/**
 * The verification state Zeke acts on: the SAME answer the money routes
 * enforce. With FEATURE_KYB_GATE off nothing is locked there, so nothing is
 * locked here — Zeke refusing a payout the authorize route would accept is a
 * second, contradictory source of truth. With the gate on, the org's recorded
 * lifecycle, failing closed if it cannot be read (as readKybGateState does).
 */
export async function zekeLaneState(orgId: string): Promise<KybLifecycleState> {
  const { kybGateEnabled, readOrgKybState } = await import('../compliance/org-kyb.ts');
  if (!kybGateEnabled()) return 'ACTIVE';
  try {
    return await readOrgKybState(orgId);
  } catch {
    return 'REGISTERED';
  }
}

const WALLET_ALTERNATIVE =
  'What you can do today: send USDC on Sui to a wallet recipient saved under Recipients — up to 5,000 USDC in any 30 days, with x402 payments counting toward the same limit. Finish verification in Account setup to unlock USD in and local-currency payouts.';

/** The refusal, in the words an operator can act on. */
export function laneRefusalText(lane: Lane, state: KybLifecycleState, currency: string | null = null): string {
  const access = laneAccess(state, lane);
  if (access.allowed) return '';
  if (state === 'SUSPENDED' || state === 'REJECTED') return access.reason;
  switch (lane) {
    case 'FIAT_OUT_LOCAL': {
      const what = currency
        ? `paying out in ${currency} — converting USD into a local currency —`
        : 'paying out to a bank account or in a local currency';
      return `I can't prepare that. Your business isn't verified yet, and ${what} stays locked until verification is complete.\n\n${WALLET_ALTERNATIVE}`;
    }
    case 'FIAT_IN_USD':
      return `I can't set that up. USD in stays locked until your business is verified. You can fund with USDC instead — including USDC from Ethereum, Arbitrum, Base or Solana, brought to your own Sui wallet through Circle's CCTP.\n\n${WALLET_ALTERNATIVE}`;
    case 'TREASURY':
      return `${access.reason} Treasury moves USDC into a yield-bearing asset, and that is only offered to verified businesses.`;
    default:
      return access.reason;
  }
}

/**
 * Zeke's words when the launch scope leaves a lane out
 * (lib/launch-scope-rules.ts), or null. Checked before verification: no
 * verification opens what this launch does not offer.
 */
export function launchScopeRefusal(lane: Lane): string | null {
  if (laneInScope(lane, launchScope())) return null;
  return `I can't prepare that. ${LAUNCH_SCOPE_REASON} I can prepare a USDC transfer to a saved wallet recipient.`;
}

/** The same for a proposal kind: what an approval here could carry out. */
export function assertZekeKindInScope(kind: string, lane: Lane = 'FIAT_OUT_LOCAL'): void {
  if (kindInScope(kind, launchScope())) return;
  throw new ZekeLaneRefusal(lane, null, `I can't prepare that. ${LAUNCH_SCOPE_REASON} I can prepare a USDC transfer to a saved wallet recipient.`);
}

/** Throw a ZekeLaneRefusal unless this org may use `lane`. */
export async function assertZekeLane(orgId: string, lane: Lane, currency: string | null = null): Promise<void> {
  const scoped = launchScopeRefusal(lane);
  if (scoped) throw new ZekeLaneRefusal(lane, null, scoped);
  const state = await zekeLaneState(orgId);
  if (!laneAccess(state, lane).allowed) {
    throw new ZekeLaneRefusal(lane, state, laneRefusalText(lane, state, currency));
  }
  const custody = lane === 'TREASURY' ? treasuryCustodyRefusal() : null;
  if (custody) throw new ZekeLaneRefusal(lane, state, custody);
}

/**
 * Treasury holds customer funds, so verification alone does not open it: it
 * also needs the custody phase, which /api/treasury enforces
 * (lib/server/custody-phase.ts). Without this a verified business in Phase 0
 * got a treasury proposal the route then refused. Worded for a question as
 * well as a request, since "what's the treasury yield?" reaches it too.
 */
export const TREASURY_CUSTODY_REFUSAL =
  `Treasury isn't open yet. ${CUSTODY_PHASE_WHY} Until then Splash pays out only, and nothing is held for you.`;

/** The Phase 0 refusal for Treasury, or null once the custody phase is on. */
export function treasuryCustodyRefusal(): string | null {
  return custodyPhaseEnabled() ? null : TREASURY_CUSTODY_REFUSAL;
}

// ─── Reading a message ──────────────────────────────────────────────────────

/** Currencies a business might ask to pay out in. Anything that is not USDC is
 *  a fiat payout here; the list only has to be long enough to recognise one. */
const CURRENCY_CODES = [
  'PHP', 'MYR', 'IDR', 'VND', 'THB', 'SGD', 'INR', 'NGN', 'KES', 'GHS', 'MXN', 'BRL', 'COP', 'ARS',
  'EUR', 'GBP', 'HKD', 'CNY', 'JPY', 'KRW', 'AUD', 'CAD', 'AED', 'PKR', 'BDT', 'LKR', 'TRY', 'ZAR',
  'EGP', 'TWD',
];
const CODE_PATTERN = new RegExp(`\\b(${CURRENCY_CODES.join('|')})\\b`, 'i');

const CURRENCY_WORDS: Array<[RegExp, string | null]> = [
  [/\bpesos?\b/i, 'pesos'],
  [/\bringgit\b/i, 'ringgit'],
  [/\brupiah\b/i, 'rupiah'],
  [/\bdong\b/i, 'dong'],
  [/\bbaht\b/i, 'baht'],
  [/\brupees?\b/i, 'rupees'],
  [/\bnaira\b/i, 'naira'],
  [/\beuros?\b/i, 'euros'],
  [/\bsterling\b/i, 'sterling'],
  [/\bsingapore dollars?\b/i, 'Singapore dollars'],
  [/\byen\b/i, 'yen'],
  [/₱/, 'PHP'],
  [/₫/, 'VND'],
  [/฿/, 'THB'],
  [/₹/, 'INR'],
  [/₦/, 'NGN'],
  [/€/, 'EUR'],
  [/£/, 'GBP'],
  [/\bRM\s?\d/, 'MYR'],
  [/\blocal currenc(?:y|ies)\b/i, null],
  [/\bfiat\b/i, null],
];

/** The currency a message names, or undefined when it names none. `null`
 *  means "a local currency" without saying which. */
function namedLocalCurrency(message: string): string | null | undefined {
  const code = message.match(CODE_PATTERN);
  if (code) return code[1].toUpperCase();
  for (const [pattern, label] of CURRENCY_WORDS) {
    if (pattern.test(message)) return label;
  }
  return undefined;
}

const PAYOUT_VERB = /\b(pay|pays|paying|payment|payments|send|sending|transfer|transferring|payout|pay out|settle|remit|wire|disburse)\b/i;
const CONVERT_VERB = /\b(convert|converting|exchange)\b/i;
const RATE_QUESTION = /\b(rate|rates|how much is|how much would|quote)\b/i;
const BANK_TARGET = /\b(bank account|to (?:their|his|her|my|our|the) bank)\b/i;
const STABLECOIN_TARGET = /\b(usdc|wallet|sui)\b/i;
const USD_IN = /\b(deposit|fund|top ?up|add funds|wire in|bank in)\b/i;
const USD_WORD = /\b(usd|dollars?|bank wire|wire transfer|ach|swift)\b/i;
const TREASURY_WORD = /\b(treasury|vault|usdy)\b/i;
const TREASURY_VERB = /\b(allocate|deposit|move|put|invest|fund|sweep|park|stake|swap)\b/i;

export interface LaneIntent {
  lane: Lane;
  currency: string | null;
}

/**
 * The lane a message asks to use, when it asks for a locked one. Deliberately
 * narrow: a question ABOUT the PHP rate is not a payout, and refusing it would
 * teach operators that Zeke says no to everything. Only a request to move or
 * convert money is classified.
 */
export function classifyLaneIntent(message: string): LaneIntent | null {
  // A pasted x402 challenge is the X402 lane, which onboarding may use; its
  // JSON is full of words that would otherwise read as a payout.
  if (/x402Version/.test(message)) return null;

  const currency = namedLocalCurrency(message);
  const pays = PAYOUT_VERB.test(message);
  const converts = CONVERT_VERB.test(message) && !RATE_QUESTION.test(message);

  if (currency !== undefined && (pays || converts)) {
    return { lane: 'FIAT_OUT_LOCAL', currency };
  }
  if (pays && BANK_TARGET.test(message) && !STABLECOIN_TARGET.test(message)) {
    return { lane: 'FIAT_OUT_LOCAL', currency: null };
  }
  if (USD_IN.test(message) && USD_WORD.test(message) && !/\busdc\b/i.test(message)) {
    return { lane: 'FIAT_IN_USD', currency: 'USD' };
  }
  if (TREASURY_WORD.test(message) && TREASURY_VERB.test(message)) {
    return { lane: 'TREASURY', currency: null };
  }
  return null;
}

/** Whole USDC with two decimals, rounded DOWN: an allowance is never overstated. */
export function formatUsdcAllowance(minor: bigint): string {
  const cents = minor / 10_000n;
  const whole = cents / 100n;
  const frac = (cents % 100n).toString().padStart(2, '0');
  return `${whole.toLocaleString('en-US')}.${frac}`;
}
