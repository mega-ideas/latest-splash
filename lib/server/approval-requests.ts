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
import { formatMinor, parseMinor, USD_DECIMALS } from '@/lib/money';
import type { UnsignedProposal } from '@/lib/agent/types';
import type { WalletAction, WalletTxDescription } from '@/lib/wallet/wallet-tx-describe';
import { transactionCode } from '@/lib/wallet/review-on-device';
import type { SigningNotifier, WithdrawalSigningDetails } from '@/lib/server/wallet-signing';
import type { SigningPurpose } from '@/lib/server/wallet-signing-store';
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
    ? `${head}Your code is ${input.code}\nEnter it in Splash, on the Approval queue page, to approve. It expires in 30 minutes.\n\n` +
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

// ─── Business Splash Wallet signatures (v2 §4.1) ────────────────────────────
//
// A wallet signature request is not a vote, and it is not answered on
// WhatsApp: the answer is a passkey signature over exact transaction bytes,
// which only the signer's own device can make, in Splash. So the message
// says what the transaction does, read from its bytes on the server
// (lib/wallet/wallet-tx-describe.ts), who else must sign, and when it
// expires, and asks the person to open Splash. It carries no code, no
// link and no transaction bytes. The in-app inbox (lib/server/wallet-signing.ts,
// `signingInbox`) is the other channel, and the one that always works.

const USDC_DECIMALS_V2 = 6;

function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function usdc(minor: string): string {
  const [whole, frac] = formatMinor(BigInt(minor), USDC_DECIMALS_V2).split('.');
  const trimmed = frac.replace(/0+$/, '').padEnd(2, '0');
  return `${BigInt(whole).toLocaleString('en-US')}.${trimmed} USDC`;
}

function localAmount(minor: string, currency: string): string {
  const n = BigInt(minor);
  // IDR is paid in whole rupiah (lib/payments/iso20022.ts LOCAL_DECIMALS); PHP and MYR in hundredths.
  if (currency === 'IDR') return `${currency} ${n.toLocaleString('en-US')}`;
  return `${currency} ${(n / 100n).toLocaleString('en-US')}.${(n % 100n).toString().padStart(2, '0')}`;
}

function rateOf(rateMicro: string, currency: string): string {
  const n = BigInt(rateMicro);
  return `${n / 1_000_000n}.${(n % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '').padEnd(2, '0')} ${currency} per USDC`;
}

/** One line on what the bytes do, for a person about to sign them. A withdrawal names the bank account it pays. */
export function walletRequestHeadline(purpose: SigningPurpose, d: WalletTxDescription, withdrawal?: WithdrawalSigningDetails | null): string {
  const a = d.actions;
  switch (purpose) {
    case 'nominate_wallet': {
      const n = a[0] as Extract<WalletAction, { type: 'nominate_wallet' }>;
      return `name ${shortAddress(n.wallet)} as the business wallet${n.singleSigner ? ' (one owner can sign alone)' : ''}`;
    }
    case 'register_wallet': {
      const r = a[0] as Extract<WalletAction, { type: 'register_wallet' }>;
      return `register the business wallet ${shortAddress(r.wallet)}: ${r.threshold} of ${r.members.length} owners sign`;
    }
    case 'rotate_wallet': {
      const r = a[0] as Extract<WalletAction, { type: 'rotate_wallet' }>;
      return `move the business wallet to ${shortAddress(r.newWallet)}: ${r.threshold} of ${r.members.length} owners sign`;
    }
    case 'confirm_wallet_rotation':
      return 'confirm the new business wallet';
    case 'cancel_wallet_rotation':
      return 'cancel the business wallet change';
    case 'wallet_membership': {
      const m = a[0] as Extract<WalletAction, { type: 'add_owner' | 'remove_owner' | 'set_recovery_party' }>;
      const verb = m.type === 'add_owner' ? 'add an owner' : m.type === 'remove_owner' ? 'remove an owner' : 'set the recovery party';
      return `${verb}: ${shortAddress(m.address)}`;
    }
    case 'wallet_payment': {
      const open = a.find((x) => x.type === 'open_intent') as Extract<WalletAction, { type: 'open_intent' }> | undefined;
      const pay = a.find((x) => x.type === 'pay_intent') as Extract<WalletAction, { type: 'pay_intent' }>;
      const fee = BigInt(pay.maxFeeMinor) > 0n ? `, Splash fee at most ${usdc(pay.maxFeeMinor)}` : '';
      if (open) return `pay ${usdc(open.amountMinor)} to ${shortAddress(open.recipient)}${fee}`;
      // An existing intent: its payee and principal were read from the chain
      // and bound into the request (the describer refuses it otherwise).
      if (pay.intent) return `pay ${usdc(pay.intent.amountMinor)} to ${shortAddress(pay.intent.recipient)}, a payment a team member prepared${fee}`;
      return `pay a payment whose payee could not be read${fee}`;
    }
    case 'withdrawal': {
      const open = a.find((x) => x.type === 'open_intent') as Extract<WalletAction, { type: 'open_intent' }>;
      const pay = a.find((x) => x.type === 'pay_intent') as Extract<WalletAction, { type: 'pay_intent' }>;
      const fee = BigInt(pay.maxFeeMinor) > 0n ? `, Splash fee at most ${usdc(pay.maxFeeMinor)}` : '';
      if (withdrawal) {
        const by = new Date(Number(withdrawal.settleByMs)).toISOString().slice(0, 16).replace('T', ' ');
        return (
          `withdraw ${usdc(open.amountMinor)} to the business's own bank account ${withdrawal.holderName}, bank ${withdrawal.bankCode}, account ending ${withdrawal.last4}: ` +
          `about ${localAmount(withdrawal.receiveMinor, withdrawal.currency)} at ${rateOf(withdrawal.rateMicro, withdrawal.currency)}, and at least ${localAmount(withdrawal.minReceiveMinor, withdrawal.currency)} or the USDC comes back, ` +
          `through the payout partner's deposit address ${shortAddress(open.recipient)}${fee}; sign by ${by} UTC`
        );
      }
      return `withdraw ${usdc(open.amountMinor)} to the business's own bank account in ${open.targetCurrency}, through the payout partner's deposit address ${shortAddress(open.recipient)}${fee}`;
    }
    case 'partner_payout': {
      // §4.5: the payee is the supplier the bytes commit to by a salted hash,
      // so the account it was built from is named here, as for a withdrawal.
      const open = a.find((x) => x.type === 'open_intent') as Extract<WalletAction, { type: 'open_intent' }>;
      const pay = a.find((x) => x.type === 'pay_intent') as Extract<WalletAction, { type: 'pay_intent' }>;
      const fee = BigInt(pay.maxFeeMinor) > 0n ? `, Splash fee at most ${usdc(pay.maxFeeMinor)}` : '';
      if (withdrawal) {
        const by = new Date(Number(withdrawal.settleByMs)).toISOString().slice(0, 16).replace('T', ' ');
        return (
          `pay ${usdc(open.amountMinor)} to ${withdrawal.holderName}, bank ${withdrawal.bankCode}, account ending ${withdrawal.last4}${withdrawal.purposeCode ? ` (purpose ${withdrawal.purposeCode})` : ''}: ` +
          `about ${localAmount(withdrawal.receiveMinor, withdrawal.currency)} at ${rateOf(withdrawal.rateMicro, withdrawal.currency)}, and at least ${localAmount(withdrawal.minReceiveMinor, withdrawal.currency)} or the USDC comes back, ` +
          `through the payout partner's deposit address ${shortAddress(open.recipient)}${fee}; sign by ${by} UTC`
        );
      }
      return `pay ${usdc(open.amountMinor)} to a supplier's bank account in ${open.targetCurrency}, through the payout partner's deposit address ${shortAddress(open.recipient)}${fee}`;
    }
    case 'partner_test_deposit': {
      const s = a.find((x) => x.type === 'send_funds') as Extract<WalletAction, { type: 'send_funds' }>;
      return `send a test deposit of ${s.amountMinor ? usdc(s.amountMinor) : 'USDC'} to the payout partner's deposit address ${shortAddress(s.recipient)}`;
    }
    case 'migration_transfer': {
      const s = a.find((x) => x.type === 'send_funds') as Extract<WalletAction, { type: 'send_funds' }>;
      return `move ${s.amountMinor ? usdc(s.amountMinor) : 'your USDC'} from your own wallet to the business wallet ${shortAddress(s.recipient)}`;
    }
    case 'rotation_transfer': {
      const s = a.find((x) => x.type === 'send_funds') as Extract<WalletAction, { type: 'send_funds' }>;
      return `move ${s.amountMinor ? usdc(s.amountMinor) : 'the USDC'} from the old business wallet to the new one, ${shortAddress(s.recipient)}`;
    }
    case 'spend_policy': {
      const p = a[0] as Extract<WalletAction, { type: 'create_spend_policy' }>;
      return `set up spending rules for the business wallet, at most ${usdc(p.perPaymentMaxMinor)} a payment`;
    }
    case 'spend_rule':
      return spendRuleHeadline(a);
    case 'spend_approval': {
      const p = a[0] as Extract<WalletAction, { type: 'approve_payout' }>;
      return `approve ${usdc(p.intent.amountMinor)} to ${shortAddress(p.intent.recipient)}, paid by ${shortAddress(p.payer)}, at most ${usdc(p.maxTotalMinor)} with Splash's fee`;
    }
  }
}

/** A spending-rule change in a line: each rule given, changed or taken back, and recipient changes. */
function spendRuleHeadline(a: WalletAction[]): string {
  const parts: string[] = [];
  const revoked = new Set(a.filter((x) => x.type === 'revoke_allowance').map((x) => (x as { allowance: string }).allowance));
  for (const x of a) {
    if (x.type === 'propose_allowance') {
      const cap = x.rateLimit ? `${usdc(x.rateLimit.limitMinor)} a ${x.rateLimit.window.kind === 'calendar' ? 'month' : 'day'}` : 'no recurring cap';
      const until = x.expiresAtMs ? ` until ${new Date(Number(x.expiresAtMs)).toISOString().slice(0, 10)}` : '';
      parts.push(`${revoked.size ? 'change' : 'give'} ${shortAddress(x.spender)} a spending rule of ${cap}${until}`);
    }
  }
  const takenBack = a.filter((x) => x.type === 'remove_spender' && !a.some((y) => y.type === 'add_spender' && y.spender === x.spender));
  for (const x of takenBack) parts.push(`take back ${shortAddress((x as { spender: string }).spender)}'s spending rule`);
  const added = a.filter((x) => x.type === 'verify_recipient' || x.type === 'verify_beneficiary').length;
  const removed = a.filter((x) => x.type === 'remove_recipient' || x.type === 'remove_beneficiary').length;
  if (added) parts.push(`verify ${added} recipient${added === 1 ? '' : 's'}`);
  if (removed) parts.push(`remove ${removed} recipient${removed === 1 ? '' : 's'}`);
  if (a.some((x) => x.type === 'set_limits' || x.type === 'set_running_window')) parts.push('change the spending limits');
  if (parts.length === 0 && revoked.size) parts.push(`revoke ${revoked.size} spending rule${revoked.size === 1 ? '' : 's'}`);
  return parts.join('; ') || 'change the spending rules';
}

export function walletSignatureMessage(input: { orgName: string; purpose: SigningPurpose; description: WalletTxDescription; withdrawal?: WithdrawalSigningDetails | null; threshold: number; signerCount: number; expiresAt: Date; now: Date }): string {
  const hours = Math.max(1, Math.round((input.expiresAt.getTime() - input.now.getTime()) / 3_600_000));
  const who = input.signerCount > 1 ? `${input.threshold} of ${input.signerCount} owners must sign.` : 'Only you can sign this.';
  return (
    `Splash: your signature is needed\n\n` +
    `${input.orgName} asks you to ${walletRequestHeadline(input.purpose, input.description, input.withdrawal)}.\n` +
    `${who} Splash pays the network fee.\n\n` +
    `Open Splash, check the details and the transaction code ${transactionCode(input.description.bytesHash)}, and sign with your passkey. ` +
    `This request expires in ${hours} hour${hours === 1 ? '' : 's'}.\n\n` +
    `If you did not expect this, do not sign it.`
  );
}

/**
 * Tell each signer, on WhatsApp where they have a verified number. Never
 * throws, like requestApprovals: the inbox in the app is always there.
 */
export function walletSigningNotifier(deps: { orgName: (orgId: string) => Promise<string>; channels: (orgId: string) => Promise<Approver[]> }): SigningNotifier {
  return {
    async notify({ orgId, request, description, userIds, now }) {
      const delivered: string[] = [];
      const unreachable: string[] = [];
      let orgName = 'Your business';
      let people: Approver[] = [];
      try {
        [orgName, people] = await Promise.all([deps.orgName(orgId), deps.channels(orgId)]);
      } catch {
        return { delivered, unreachable: [...userIds] };
      }
      const settings = await readOrgSettings(orgId).catch(() => null);
      const body = walletSignatureMessage({
        orgName,
        purpose: request.purpose,
        description,
        withdrawal: (request.summary as { withdrawal?: WithdrawalSigningDetails } | null)?.withdrawal ?? null,
        threshold: request.threshold,
        signerCount: request.signers.length,
        expiresAt: request.expiresAt,
        now,
      });
      for (const userId of userIds) {
        if (userId === request.requestedBy && request.signers.length > 1) {
          // The person who asked is in the app already; they are not messaged.
          continue;
        }
        const person = people.find((p) => p.userId === userId);
        if (!settings?.whatsappEnabled || !whatsappConfigured() || !person?.whatsappE164) {
          unreachable.push(userId);
          continue;
        }
        const result = await sendWhatsApp(person.whatsappE164, body).catch(() => ({ sent: false as const }));
        if (result.sent) delivered.push(userId);
        else unreachable.push(userId);
      }
      return { delivered, unreachable };
    },
  };
}

/**
 * A staff member asked the owners to approve a payment: tell each owner on
 * WhatsApp where they have a verified number. Never throws; the ask is in
 * their inbox in the app either way.
 */
export async function notifyOwnersOfAsk(input: {
  orgId: string;
  orgName: string;
  ownerUserIds: string[];
  amountMinor: string;
  recipient: string;
}): Promise<{ delivered: string[]; unreachable: string[] }> {
  const delivered: string[] = [];
  const unreachable: string[] = [];
  try {
    const [people, settings] = await Promise.all([listApprovers(input.orgId), readOrgSettings(input.orgId).catch(() => null)]);
    const amount = BigInt(input.amountMinor);
    const usdc = `${(amount / 1_000_000n).toLocaleString('en-US')}.${(amount % 1_000_000n).toString().padStart(6, '0').slice(0, 2)}`;
    const payee = `${input.recipient.slice(0, 6)}…${input.recipient.slice(-4)}`;
    const body = `${input.orgName}: a member of your team asks you to approve a payment of ${usdc} USDC to ${payee}.\n\nOpen Splash to review it. Nothing is paid until the owners sign.`;
    for (const userId of input.ownerUserIds) {
      const person = people.find((p) => p.userId === userId);
      if (!settings?.whatsappEnabled || !whatsappConfigured() || !person?.whatsappE164) {
        unreachable.push(userId);
        continue;
      }
      const result = await sendWhatsApp(person.whatsappE164, body).catch(() => ({ sent: false as const }));
      if (result.sent) delivered.push(userId);
      else unreachable.push(userId);
    }
  } catch {
    return { delivered, unreachable: input.ownerUserIds.filter((u) => !delivered.includes(u)) };
  }
  return { delivered, unreachable };
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
    // Not "being sent": whether it is sent now depends on who completed the
    // vote. A reply cannot send a payment; a signed-in approver can
    // (lib/server/approval-settle.ts). Both routes answer with the settle
    // outcome instead of this.
    return {
      ok: true,
      decision: input.decision,
      tally: counted,
      message: 'Approved by everyone.',
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
