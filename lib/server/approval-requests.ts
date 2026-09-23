/**
 * Asking the approvers, and acting on what they say.
 *
 * One module for both channels, because the rules must not differ by how the
 * answer arrived. A decision typed into Splash and a decision replied on
 * WhatsApp go through the same function, get the same checks, and are recorded
 * the same way — the channel only determines how the question was delivered.
 *
 * ─── What a WhatsApp message may and may not say ────────────────────────────
 *
 * The message names the amount, the beneficiary and the org, because an
 * approver deciding on "a payment is waiting" is not deciding anything. It does
 * NOT carry the beneficiary's account number, the corridor routing, or a link
 * that logs anyone in: WhatsApp is not a channel we control, messages persist
 * on handsets and in backups, and an approval request is not a place to put
 * payment instructions.
 */
import 'server-only';

import { canApprove } from '@/lib/membership-roles';
import { parseMinor, USD_DECIMALS } from '@/lib/money';
import type { UnsignedProposal } from '@/lib/agent/types';
import { listApprovers, type Approver } from '@/lib/server/approver-channels';
import { issueTokens, recordDecision, tally, type Tally } from '@/lib/server/approval-tokens';
import { readOrgSettings } from '@/lib/server/org-settings';
import { sendWhatsApp, whatsappConfigured } from '@/lib/server/whatsapp';

export type RequestOutcome = {
  approversAsked: number;
  delivered: number;
  channel: 'code' | 'reply';
  /** Approvers with no verified number. They can still act in the app, and the
   *  operator needs to know reaching them took a different route. */
  unreachable: string[];
};

/**
 * The amount an approver reads before saying yes.
 *
 * Integer arithmetic, not `parseFloat` and `toLocaleString`. This is the one
 * place in the product where a misrendered number is worst: the reader is
 * about to release the money, and they are checking the figure against what
 * they expected. A float that renders 250000.00 as 249999.99 costs nothing
 * anywhere else and costs the approval here.
 */
function money(amountUsd: string): string {
  let minor: bigint;
  try {
    minor = parseMinor(amountUsd, USD_DECIMALS, 'half-up');
  } catch {
    // Unparseable: show it verbatim rather than inventing a number.
    return `${amountUsd} USD`;
  }
  const negative = minor < 0n;
  const abs = negative ? -minor : minor;
  const unit = 10n ** BigInt(USD_DECIMALS);
  const whole = (abs / unit).toLocaleString('en-US');
  const cents = (abs % unit).toString().padStart(USD_DECIMALS, '0');
  return `${negative ? '-' : ''}$${whole}.${cents}`;
}

function messageFor(input: {
  proposal: UnsignedProposal;
  orgName: string;
  amountUsd: string;
  channel: 'code' | 'reply';
  code: string;
}): string {
  const what =
    input.proposal.kind === 'BATCH_PAYOUT'
      ? 'a batch payout'
      : input.proposal.kind === 'PAYMENT'
        ? 'a payment'
        : input.proposal.kind.toLowerCase().replace(/_/g, ' ');

  const head =
    `Splash — approval needed\n\n` +
    `${input.orgName} wants to send ${money(input.amountUsd)} (${what}).\n` +
    `${input.proposal.explain.recommendation}\n\n` +
    `Every approver must agree. One rejection stops it.\n\n`;

  // The two channels ask for materially different things, so they say so
  // plainly rather than sharing a vague "respond to approve".
  return input.channel === 'code'
    ? `${head}Your code is ${input.code}\nEnter it in Splash to approve. It expires in 30 minutes.\n\n` +
        `If you did not expect this, do not enter the code — reply REJECT.`
    : `${head}Reply APPROVE or REJECT. This request expires in 30 minutes.`;
}

/**
 * Ask everyone who may approve.
 *
 * Never throws. A notification that could not be delivered must not take down
 * the payment path that raised it: the proposal exists, the queue shows it, and
 * an approver can still act in the app. Silence on WhatsApp is a degraded
 * channel, not a failed payment — and the caller is told how many were actually
 * reached so it can say so rather than implying everyone was.
 */
export async function requestApprovals(input: {
  proposal: UnsignedProposal;
  orgName: string;
  amountUsd: string;
  /** The maker never votes on their own payment. */
  excludeUserId: string;
  now: Date;
}): Promise<RequestOutcome> {
  const settings = await readOrgSettings(input.proposal.orgId);
  const channel = settings.approvalChannel;

  const everyone = await listApprovers(input.proposal.orgId);
  // maker != checker, applied at the point the question is asked. The state
  // machine enforces it again when the answer comes back; asking in the first
  // place would just be noise the maker cannot act on.
  const approvers = everyone.filter((a) => a.userId !== input.excludeUserId);

  const tokens = await issueTokens({
    proposalId: input.proposal.id,
    orgId: input.proposal.orgId,
    approvers,
    channel,
    now: input.now,
  });

  const unreachable: string[] = [];
  let delivered = 0;

  if (settings.whatsappEnabled && whatsappConfigured()) {
    for (const token of tokens) {
      if (!token.sentTo) {
        const who = approvers.find((a) => a.userId === token.userId);
        unreachable.push(who?.email ?? token.userId);
        continue;
      }
      const result = await sendWhatsApp(
        token.sentTo,
        messageFor({
          proposal: input.proposal,
          orgName: input.orgName,
          amountUsd: input.amountUsd,
          channel,
          code: token.code,
        }),
      );
      if (result.sent) delivered += 1;
      else {
        const who = approvers.find((a) => a.userId === token.userId);
        unreachable.push(who?.email ?? token.userId);
      }
    }
  } else {
    for (const approver of approvers) unreachable.push(approver.email);
  }

  return { approversAsked: approvers.length, delivered, channel, unreachable };
}

export type DecisionResult =
  | { ok: true; decision: 'APPROVE' | 'REJECT'; tally: Tally; message: string }
  | { ok: false; message: string };

/**
 * Apply one approver's decision, from either channel.
 *
 * The role is re-checked HERE and not only when the request went out: a role
 * revoked between the question and the answer must not still release money.
 */
export async function applyDecision(input: {
  tokenId: string;
  proposalId: string;
  approver: Approver;
  decision: 'APPROVE' | 'REJECT';
  now: Date;
}): Promise<DecisionResult> {
  if (!canApprove(input.approver.role)) {
    return { ok: false, message: 'Your role can no longer approve payments.' };
  }

  // Single-use, enforced by the UPDATE's own WHERE clause rather than a prior
  // read — two replies arriving together would both pass a check-then-write.
  const recorded = await recordDecision(input.tokenId, input.decision, input.now);
  if (!recorded) {
    return { ok: false, message: 'You have already answered this request.' };
  }

  const counted = await tally(input.proposalId);

  if (counted.refused) {
    return {
      ok: true,
      decision: input.decision,
      tally: counted,
      // Terminal, and said plainly: an approver who rejects should not be left
      // wondering whether the others can still push it through.
      message: 'Rejected. The payment will not be sent, and no further approvals can change that.',
    };
  }

  if (counted.unanimous) {
    return {
      ok: true,
      decision: input.decision,
      tally: counted,
      message: 'Approved by everyone. The payment is being sent.',
    };
  }

  const waiting = counted.total - counted.approved;
  return {
    ok: true,
    decision: input.decision,
    tally: counted,
    message: `Approved. Waiting on ${waiting} more approver${waiting === 1 ? '' : 's'}.`,
  };
}
