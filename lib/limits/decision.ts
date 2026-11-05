/**
 * What the staff queue card offers and sends (v2 Phase 3). Pure, so the button and the body it sends are tested
 * together: the label on the button and the request behind it must name the same figure.
 *
 * When a first approval stands and it is someone else's, the second approver can only agree with that figure or
 * decline: the server refuses any other figure (figure_differs). So the card then offers "Approve <the first
 * approver's figure>", and a click on it sends that figure, as a plain approve when it is the figure asked for and
 * as "approve a smaller figure" with the first approver's figure when it is not.
 */
import { isLimitKind, limitInputValue } from './rules.ts';

export type DecisionChoice = 'approve' | 'approve_smaller' | 'decline';

export type DecisionCard = {
  kind: string;
  /** The figure asked for, in minor units. */
  requested: string;
  approvals: {
    needed: 1 | 2;
    first: null | { figure: string; figureWords: string };
    youApprovedFirst: boolean;
  };
};

/** True when someone else has given the first of two approvals: the figure is theirs and cannot be changed. */
export const secondApprovalStands = (card: DecisionCard): boolean => Boolean(card.approvals.first) && !card.approvals.youApprovedFirst;

/** The choices on the card, with their labels. */
export function decisionChoices(card: DecisionCard): Array<[DecisionChoice, string]> {
  if (secondApprovalStands(card) && card.approvals.first) {
    return [
      ['approve', `Approve ${card.approvals.first.figureWords}, as the first approver did`],
      ['decline', 'Decline'],
    ];
  }
  return [
    ['approve', 'Approve as asked'],
    ['approve_smaller', 'Approve a smaller figure'],
    ['decline', 'Decline'],
  ];
}

/** The body of the request the card sends for a choice. */
export function decisionBody(card: DecisionCard, choice: DecisionChoice, typed: { smaller: string; reason: string }): { action: DecisionChoice; granted?: string; reason?: string } {
  if (choice === 'decline') return { action: 'decline', reason: typed.reason };
  if (secondApprovalStands(card) && card.approvals.first && card.approvals.first.figure !== card.requested && isLimitKind(card.kind)) {
    // The first approver approved a smaller figure: agreeing means sending that figure, not the one asked for.
    return { action: 'approve_smaller', granted: limitInputValue(card.kind, BigInt(card.approvals.first.figure)) };
  }
  if (choice === 'approve_smaller') return { action: 'approve_smaller', granted: typed.smaller };
  return { action: 'approve' };
}
