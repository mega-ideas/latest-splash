/**
 * What a wallet transaction does, for the signing screen (v2 brief 4.1, 5.5).
 * The commands are decoded on the signer's own device from the exact bytes
 * (lib/wallet/review-on-device.ts); this words them. Every command the
 * decoder can return has a renderer here, checked by the compiler (the map is
 * keyed by every command type) and by a test. A command is never folded into
 * a generic line and an address is never shortened: the signer sees the full
 * address, amount, limit and window that the bytes carry. A command that
 * somehow has no wording is labelled "Not shown here" and the panel will not
 * sign it.
 */
import { formatUsdc } from '../fees/copy.ts';
import type { WalletAction } from '../wallet/wallet-tx-describe.ts';

type Action = { type: string } & Record<string, unknown>;

/** One labelled value. An address is shown in full, grouped by the panel. */
export type ShownField = { label: string; value: string; address?: boolean };
/** One command, worded. `covered` means the panel's own rows already show all of it. */
export type ShownAction = { line: string; fields: ShownField[]; unknown?: boolean; covered?: boolean };

const usdc = (minor: unknown): string => {
  try {
    return `${formatUsdc(BigInt(String(minor)))} USDC`;
  } catch {
    return 'an amount';
  }
};

const addr = (label: string, value: unknown): ShownField => ({ label, value: String(value ?? ''), address: true });
const num = (label: string, minor: unknown): ShownField => ({ label, value: usdc(minor) });

function days(ms: unknown): string {
  try {
    const n = Number(BigInt(String(ms)));
    const day = 24 * 3600 * 1000;
    if (n % day === 0) return `${n / day} ${n / day === 1 ? 'day' : 'days'}`;
    if (n % 3600000 === 0) return `${n / 3600000} hours`;
    return `${Math.round(n / 60000)} minutes`;
  } catch {
    return 'a period';
  }
}

function when(ms: unknown): string {
  try {
    return `${new Date(Number(BigInt(String(ms)))).toISOString().slice(0, 10)} (UTC)`;
  } catch {
    return 'a date';
  }
}

function cap(r: { window: { kind: string; periodMs?: string; months?: number }; limitMinor: string }): string {
  const every = r.window.kind === 'calendar' ? `each calendar month (UTC)` : `every ${days(r.window.periodMs)}`;
  return `${usdc(r.limitMinor)} ${every}`;
}

type Renderers = { [K in WalletAction['type']]: (a: WalletAction & { type: K }) => ShownAction };
const members = (list: Array<{ address: string; weight: number }>): ShownField[] => list.map((m, i) => ({ label: `Signer ${i + 1} (weight ${m.weight})`, value: m.address, address: true }));
const plain = (line: string): ShownAction => ({ line, fields: [] });

const RENDER: Renderers = {
  nominate_wallet: (a) => ({ line: a.singleSigner ? 'Name the new business wallet on your business account. One signer controls it.' : 'Name the new business wallet on your business account.', fields: [addr('Wallet', a.wallet)] }),
  register_wallet: (a) => ({ line: `Create your business wallet: ${a.threshold} of ${a.members.length} owners sign every payment.${a.singleSignerAck ? ' One signer controls it.' : ''}`, fields: [addr('Wallet', a.wallet), ...members(a.members)] }),
  rotate_wallet: (a) => ({ line: `Change who signs for the business wallet: ${a.threshold} of ${a.members.length} owners will sign.${a.singleSignerAck ? ' One signer controls it.' : ''}`, fields: [addr('New wallet', a.newWallet), ...members(a.members)] }),
  confirm_wallet_rotation: () => plain('Confirm the new set of signers for the business wallet.'),
  cancel_wallet_rotation: () => plain('Withdraw the change of signers that is waiting.'),
  add_owner: (a) => ({ line: 'Make this address an owner of the business account.', fields: [addr('Owner', a.address)] }),
  remove_owner: (a) => ({ line: 'Remove this address as an owner of the business account.', fields: [addr('Owner', a.address)] }),
  set_recovery_party: (a) => ({ line: 'Set this address as the recovery contact.', fields: [addr('Recovery contact', a.address)] }),
  withdraw: (a) => ({ line: `Take ${usdc(a.amountMinor)} out of the wallet balance.`, fields: [], covered: true }),
  merge_coins: (a) => plain(`Combine ${a.coins} USDC coins into one.`),
  coin_to_balance: () => plain('Prepare the USDC coin for sending.'),
  join_balance: () => plain('Join the prepared USDC into one amount.'),
  send_funds: (a) => ({ line: a.amountMinor ? `Send ${usdc(a.amountMinor)} to the address below. Check it is the address you expect.` : 'Send the USDC to the address below. Check it is the address you expect.', fields: [addr('To', a.recipient), ...(a.amountMinor ? [num('Amount', a.amountMinor)] : [])] }),
  open_intent: (a) => ({ line: `Open a payment of ${usdc(a.amountMinor)}${a.underRule ? ' under your spending rule' : ''}.`, fields: [addr('To', a.recipient), num('Amount', a.amountMinor)], covered: true }),
  pay_intent: (a) =>
    a.underRule
      ? {
          line: `Pay it from your business wallet under your spending rule. Splash fee at most ${usdc(a.maxFeeMinor)}; up to ${usdc(a.underRule.withdrawalMinor)} is taken in all, and what the fee does not use stays in the wallet.`,
          fields: [],
          covered: true,
        }
      : a.intent
        ? { line: `Pay the open payment of ${usdc(a.intent.amountMinor)}. Splash fee at most ${usdc(a.maxFeeMinor)}.`, fields: [addr('To', a.intent.recipient), num('Amount', a.intent.amountMinor), num('Splash fee at most', a.maxFeeMinor)] }
        : { line: `Pay the payment opened here. Splash fee at most ${usdc(a.maxFeeMinor)}.`, fields: [], covered: true },
  no_second_approval: () => ({ line: 'No second approval is attached: this payment is within your rule.', fields: [], covered: true }),
  anchor_receipt: () => plain('Record the receipt of this payment.'),
  delete_intent: () => plain('Remove the finished payment record.'),
  create_spend_policy: (a) => ({ line: `Start your spending rules: ${a.threshold} of ${a.members.length} owners approve changes. No payment above ${usdc(a.perPaymentMaxMinor)} unless the rules allow it.`, fields: [addr('Wallet', a.wallet), num('Most per payment', a.perPaymentMaxMinor), ...members(a.members)] }),
  add_spender: (a) => ({ line: `Let this address spend as ${a.role === 'staff' ? 'staff' : 'an automatic payer'}, up to ${usdc(a.perPaymentMaxMinor)} a payment.`, fields: [addr('Spender', a.spender), num('Most per payment', a.perPaymentMaxMinor)] }),
  remove_spender: (a) => ({ line: 'Stop this address spending from the wallet.', fields: [addr('Spender', a.spender)] }),
  verify_recipient: (a) => ({ line: 'Add this address to the payees the wallet may pay.', fields: [addr('Payee address', a.address)] }),
  remove_recipient: (a) => ({ line: 'Take this address off the payees the wallet may pay.', fields: [addr('Payee address', a.address)] }),
  verify_beneficiary: (a) => ({
    line: 'Fix this as the deposit address that bank payouts go to. It must match the deposit address on your Wallet page. Every later payout of this kind goes to it.',
    fields: [addr('Deposit address', a.partnerDeposit), { label: 'Payee reference', value: a.commitment }],
  }),
  remove_beneficiary: (a) => ({ line: 'Remove this payout destination. Payouts to it stop.', fields: [{ label: 'Payee reference', value: a.commitment }] }),
  set_limits: (a) => ({ line: `Change the limits: at most ${usdc(a.perPaymentMaxMinor)} a payment, and a second approval from ${usdc(a.secondApprovalThresholdMinor)}.`, fields: [num('Most per payment', a.perPaymentMaxMinor), num('Second approval from', a.secondApprovalThresholdMinor)] }),
  set_running_window: (a) => ({ line: `Count payments to the same payee over ${days(a.windowMs)}.`, fields: [{ label: 'Window', value: days(a.windowMs) }] }),
  rate_limit: (a) => ({ line: `Set a recurring cap of ${cap(a)}.`, fields: [num('Cap', a.limitMinor)] }),
  wrap_rate_limit: () => plain('Attach the recurring cap to the allowance below.'),
  propose_allowance: (a) => ({
    line: `Give this address an allowance named "${a.name}".${a.lifetimeCapMinor ? ` Lifetime cap ${usdc(a.lifetimeCapMinor)}.` : ' No lifetime cap.'}`,
    fields: [
      addr('Spender', a.spender),
      { label: 'Name', value: a.name },
      ...(a.lifetimeCapMinor ? [num('Lifetime cap', a.lifetimeCapMinor)] : []),
      ...(a.rateLimit ? [{ label: 'Recurring cap', value: cap(a.rateLimit) }] : []),
      ...(a.startsAtMs ? [{ label: 'Starts', value: when(a.startsAtMs) }] : []),
      ...(a.expiresAtMs ? [{ label: 'Ends', value: when(a.expiresAtMs) }] : [{ label: 'Ends', value: 'Never, until you take it back' }]),
    ],
  }),
  accept_allowance: () => plain('Accept the allowance above into your spending rules.'),
  revoke_allowance: (a) => ({ line: 'Take back an allowance. It can no longer be spent.', fields: [{ label: 'Allowance', value: a.allowance }] }),
  new_billing_allowance: (a) => ({
    line: `Let the Splash finance account draw at most ${usdc(a.monthlyLimitMinor)} each calendar month for "${a.name}".`,
    fields: [
      addr('Draws to', a.spender),
      num('Most per month', a.monthlyLimitMinor),
      ...(a.lifetimeCapMinor ? [num('Lifetime cap', a.lifetimeCapMinor)] : []),
      ...(a.startsAtMs ? [{ label: 'Starts', value: when(a.startsAtMs) }] : []),
      { label: 'Ends', value: when(a.expiresAtMs) },
    ],
  }),
  revoke_billing_allowance: (a) => ({ line: 'Take back the billing allowance. No more may be drawn.', fields: [{ label: 'Allowance', value: a.allowance }] }),
  approve_payout: (a) => ({
    line: `Approve a payout of ${usdc(a.intent.amountMinor)}, at most ${usdc(a.maxTotalMinor)} with fees.`,
    fields: [addr('Paid from', a.payer), addr('To', a.intent.recipient), num('Amount', a.intent.amountMinor), num('Most it can cost', a.maxTotalMinor), { label: 'Settle by', value: when(a.settleByMs) }],
  }),
};

/** Every command type the signing screen words. A test reads the decoder's own list against this. */
export const RENDERED_ACTION_TYPES: string[] = Object.keys(RENDER);

/** One item per decoded command, in order. A command with no wording is labelled and blocks signing. */
export function signingItems(actions: Action[]): ShownAction[] {
  return actions.map((a) => {
    const render = (RENDER as unknown as Record<string, ((x: unknown) => ShownAction) | undefined>)[a.type];
    if (!render) return { line: 'Not shown here: do not sign this request.', fields: [], unknown: true };
    try {
      return render(a);
    } catch {
      return { line: 'Not shown here: do not sign this request.', fields: [], unknown: true };
    }
  });
}

/** The same, as plain sentences. */
export function plainActions(actions: Action[]): string[] {
  return signingItems(actions).map((i) => i.line);
}
