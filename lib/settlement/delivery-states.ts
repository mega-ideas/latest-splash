/**
 * D7 — settlement delivery state machine (UI model).
 *
 * Every payout is a PaymentIntent plus one operator PTB on Sui
 * (pay · allocate · prove). The delivery leg after SETTLED_ON_SUI depends on
 * the corridor's rail (lib/network.ts `deliveryRail`):
 *   A  sui-native  → DELIVERED_TO_EXCHANGE
 *   B  cctp        → BURNED → ATTESTED → MINTED → DELIVERED
 *   C  wire        → WIRE_SENT → WIRE_CONFIRMED
 * then CONVERTED → PAID_OUT → CONFIRMED. RETURNED and HOP_STUCK are branches.
 *
 * This module only names and orders the states for rendering; it never
 * moves money and there are no Move changes behind it.
 */
import type { DeliveryRail } from '@/lib/network';

export type SettlementState =
  | 'INTENT_CREATED'
  | 'FUNDED'
  | 'SETTLED_ON_SUI'
  | 'DELIVERED_TO_EXCHANGE'
  | 'BURNED'
  | 'ATTESTED'
  | 'MINTED'
  | 'DELIVERED'
  | 'WIRE_SENT'
  | 'WIRE_CONFIRMED'
  | 'CONVERTED'
  | 'PAID_OUT'
  | 'CONFIRMED'
  | 'RETURNED'
  | 'HOP_STUCK';

export const TERMINAL_STATES: ReadonlySet<SettlementState> = new Set(['CONFIRMED', 'RETURNED']);
export const BRANCH_STATES: ReadonlySet<SettlementState> = new Set(['RETURNED', 'HOP_STUCK']);

const HEAD: SettlementState[] = ['INTENT_CREATED', 'FUNDED', 'SETTLED_ON_SUI'];
const TAIL: SettlementState[] = ['CONVERTED', 'PAID_OUT', 'CONFIRMED'];

const DELIVERY_LEG: Record<DeliveryRail, SettlementState[]> = {
  'sui-native': ['DELIVERED_TO_EXCHANGE'],
  cctp: ['BURNED', 'ATTESTED', 'MINTED', 'DELIVERED'],
  wire: ['WIRE_SENT', 'WIRE_CONFIRMED'],
};

/** The happy-path sequence for a rail, in order. */
export function settlementPath(rail: DeliveryRail): SettlementState[] {
  return [...HEAD, ...DELIVERY_LEG[rail], ...TAIL];
}

export const STATE_LABELS: Record<SettlementState, string> = {
  INTENT_CREATED: 'Intent created',
  FUNDED: 'Funded',
  SETTLED_ON_SUI: 'Settled on Sui',
  DELIVERED_TO_EXCHANGE: 'Delivered to partner',
  BURNED: 'Burned (CCTP)',
  ATTESTED: 'Attested (CCTP)',
  MINTED: 'Minted on destination',
  DELIVERED: 'Delivered to partner',
  WIRE_SENT: 'Wire sent',
  WIRE_CONFIRMED: 'Wire confirmed',
  CONVERTED: 'Converted to local currency',
  PAID_OUT: 'Paid out',
  CONFIRMED: 'Confirmed',
  RETURNED: 'Returned',
  HOP_STUCK: 'Hop stuck',
};

/** One-line operator explanation for each state; no promises, no speeds. */
export const STATE_HINTS: Partial<Record<SettlementState, string>> = {
  SETTLED_ON_SUI: 'One atomic transaction: pay, allocate, prove. This is the digest your auditor verifies.',
  DELIVERED_TO_EXCHANGE: 'Handed to the licensed payout partner on Sui.',
  CONVERTED: 'The partner converts to local currency on its own licence.',
  PAID_OUT: 'Local bank transfer issued by the partner.',
  CONFIRMED: 'The partner confirmed receipt at the supplier bank.',
  RETURNED: 'The partner returned the funds; they are back in your available balance.',
  HOP_STUCK: 'A delivery hop has not progressed. Operations are on it; nothing is lost on Sui.',
};

export type TimelineEntry = {
  state: SettlementState;
  at?: string;
  /** Evidence for this hop: a Sui digest, a partner reference, a wire ref. */
  evidence?: { label: string; value: string; href?: string };
};

export type TimelineNode = TimelineEntry & {
  label: string;
  hint?: string;
  status: 'done' | 'current' | 'todo' | 'branch';
};

/**
 * Merge observed entries onto the rail's happy path. A branch state (RETURNED,
 * HOP_STUCK) is appended after the last observed state and marks the run.
 */
export function buildTimeline(rail: DeliveryRail, entries: TimelineEntry[]): TimelineNode[] {
  const path = settlementPath(rail);
  const observed = new Map(entries.map((entry) => [entry.state, entry]));
  const branch = entries.find((entry) => BRANCH_STATES.has(entry.state));
  const lastIndex = path.reduce((acc, state, index) => (observed.has(state) ? index : acc), -1);

  const terminalReached = lastIndex === path.length - 1;

  const nodes: TimelineNode[] = path.map((state, index) => {
    const entry = observed.get(state);
    // Observed hops are done; the first unobserved hop is in progress unless
    // the run already ended (terminal state or a branch).
    const status: TimelineNode['status'] =
      index <= lastIndex ? 'done' : index === lastIndex + 1 && !branch && !terminalReached ? 'current' : 'todo';
    return { state, at: entry?.at, evidence: entry?.evidence, label: STATE_LABELS[state], hint: STATE_HINTS[state], status };
  });

  if (branch) {
    const insertAt = Math.max(0, lastIndex) + 1;
    nodes.splice(insertAt, 0, {
      ...branch,
      label: STATE_LABELS[branch.state],
      hint: STATE_HINTS[branch.state],
      status: 'branch',
    });
    // Everything after a branch is no longer on the path.
    for (let index = insertAt + 1; index < nodes.length; index += 1) nodes[index].status = 'todo';
  }

  return nodes;
}
