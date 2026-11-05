/**
 * What the Approve screen says (v2 brief 5.10), as data.
 *
 * The approver's screen shows who is paid, how much, in what asset, the fee
 * bound and the rate. None of it comes from the server's description or from
 * the page's state: it is the DeviceReview that `reviewOnDevice` made on the
 * person's own device from the exact bytes they are asked to sign (review
 * item B10), worded here. The only thing that does not come from the bytes is
 * a payee's name, which the page may know from the Review step; it is shown
 * beside the address from the bytes, never instead of it.
 *
 * Pure and client-safe: no I/O, no React.
 */
import { normalizeSuiAddress } from '@mysten/sui/utils';

import { formatUsdc, kindLabel } from '../fees/copy.ts';
import { currencyDecimals, formatMoney } from '../formatMoney.ts';
import { groupAddress } from '../transfer/addresses.ts';
import { reviewOnDevice, type DeviceReview } from '../wallet/review-on-device.ts';
import { signingItems, type ShownAction } from '../wallet-page/actions.ts';

export type ApproveRate = { currency: string; text: string; receiveApprox: string };

export type ApprovePayment = {
  /** The payee's name as the page knew it, or null. */
  payeeName: string | null;
  /** The address in the bytes, in groups of four. */
  recipient: string | null;
  amount: string;
  maxFee: string | null;
  kindLabel: string | null;
  rate: ApproveRate | null;
};

export type ApproveFacts = {
  kind: 'payment' | 'batch' | 'change';
  headline: string;
  asset: 'USDC';
  payments: ApprovePayment[];
  /** The most that can leave the wallet, every withdrawal in the transaction added; null when it withdraws nothing. */
  leavesAtMost: string | null;
  /** What the transaction does besides what the rows above already say. A batch's repeated commands are said once, with how many times. */
  steps: ShownAction[];
  /**
   * The steps of a payment or a batch that are not a payment's own known
   * bookkeeping (a send to another address, a payment opened elsewhere, any
   * command the screen does not expect here). Empty for a clean payment.
   * Counted like `steps`, and they are all in `steps` too.
   */
  unexpected: ShownAction[];
  /** Set when what leaves the wallet is not exactly the payments and their fee bounds, in words. */
  mismatch: string | null;
  /** A command the screen cannot word, a payment that does more than it says, an amount that does not add up, a rate that cannot be shown: never signed from the phone. */
  blocked: boolean;
  /** Why, in a sentence for the person; null when not blocked. */
  blockedReason: string | null;
  /** The transaction code to compare with the WhatsApp message. */
  code: string;
};

/** A rate scaled by 1e6 in plain digits: 58000000 is "58.00", 16250500000 is "16,250.50". */
export function rateText(rateMicro: string): string {
  const micro = BigInt(rateMicro);
  const whole = (micro / 1_000_000n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${whole}.${(micro % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '').padEnd(2, '0')}`;
}

/** What an amount comes to at the rate, rounded down to the currency's smallest unit, before any partner's fee. */
export function receiveApprox(amountMinor: string, rateMicro: string, currency: string): string {
  const places = BigInt(currencyDecimals(currency));
  // USDC has six places and the rate is scaled by 1e6, so the product has twelve to be brought down to the currency's.
  const local = (BigInt(amountMinor) * BigInt(rateMicro)) / 10n ** (12n - places);
  return formatMoney(local, currency);
}

const USD_LIKE = new Set(['USD', 'USDC']);

function kindText(kind: number): string | null {
  try {
    return kindLabel(kind);
  } catch {
    return null;
  }
}

function addressOf(value: string): string | null {
  try {
    return groupAddress(normalizeSuiAddress(value));
  } catch {
    return null;
  }
}

function safeUsdc(minor: string | null | undefined): string | null {
  try {
    return minor === null || minor === undefined ? null : formatUsdc(BigInt(minor));
  } catch {
    return null;
  }
}

type Action = DeviceReview['actions'][number];

/**
 * What a payment's transaction may contain besides the payment itself: the
 * bookkeeping that is always there (the receipt, the cleanup) and the coins a
 * payment may have to gather. Anything else in a payment, a send to another
 * address above all, is "also" something, and is said so, never folded under
 * the payment's headline. (The decoder accepts a send in any wallet
 * transaction; it is this screen that must not let one pass as a payment.)
 */
const PAYMENT_BOOKKEEPING = new Set(['merge_coins', 'coin_to_balance', 'join_balance', 'anchor_receipt', 'delete_intent', 'no_second_approval']);

function isKnownInPayment(a: Action): boolean {
  if (a.type === 'open_intent' || a.type === 'withdraw') return true;
  // A payment opened and paid in this transaction. One that pays an intent opened elsewhere is something else.
  if (a.type === 'pay_intent') return a.intent === null;
  return PAYMENT_BOOKKEEPING.has(a.type);
}

/** A repeated command is said once, with how many times. */
function counted(items: ShownAction[]): ShownAction[] {
  const seen = new Map<string, { item: ShownAction; times: number }>();
  for (const item of items) {
    const key = `${item.line}|${item.fields.map((f) => `${f.label}=${f.value}`).join(';')}`;
    const had = seen.get(key);
    if (had) had.times += 1;
    else seen.set(key, { item, times: 1 });
  }
  return [...seen.values()].map(({ item, times }) => (times > 1 ? { ...item, line: `${item.line.replace(/\.$/, '')}, ${times} times, once for each payment.` } : item));
}

/** A payment's rate, or why there is none to show. A currency that is not a currency code, or a rate of nothing, is a problem the signer is told about, never a crash. */
function rateOf(open: Extract<Action, { type: 'open_intent' }>): { rate: ApproveRate | null; problem: boolean } {
  const currency = open.targetCurrency;
  if (USD_LIKE.has(currency.toUpperCase())) return { rate: null, problem: false };
  try {
    if (!/^[A-Za-z]{3}$/.test(currency) || BigInt(open.fxRateUsdLocal) <= 0n) return { rate: null, problem: true };
    return { rate: { currency, text: `1 USDC = ${rateText(open.fxRateUsdLocal)} ${currency}`, receiveApprox: receiveApprox(open.amountMinor, open.fxRateUsdLocal, currency) }, problem: false };
  } catch {
    return { rate: null, problem: true };
  }
}

function build(review: DeviceReview, opts: { names?: Array<string | null | undefined> }): ApproveFacts {
  const actions = review.actions as Action[];
  const opens = actions.filter((a): a is Extract<Action, { type: 'open_intent' }> => a.type === 'open_intent');
  // Each payment is opened and paid here, in order. A pay that carries its own intent is not one of them.
  const ownPays = actions.filter((a): a is Extract<Action, { type: 'pay_intent' }> => a.type === 'pay_intent' && a.intent === null);
  const withdraws = actions.filter((a): a is Extract<Action, { type: 'withdraw' }> => a.type === 'withdraw');

  let rateProblem = false;
  const payments: ApprovePayment[] = opens.map((open, i) => {
    const pay = ownPays[i];
    const { rate, problem } = rateOf(open);
    if (problem) rateProblem = true;
    return {
      payeeName: opts.names?.[i] ?? null,
      recipient: addressOf(open.recipient),
      amount: safeUsdc(open.amountMinor) ?? 'an amount',
      maxFee: pay ? safeUsdc(pay.maxFeeMinor) : null,
      kindLabel: kindText(open.kind),
      rate,
    };
  });

  let withdrawn = 0n;
  for (const w of withdraws) withdrawn += BigInt(w.amountMinor);
  // A payment under a staff member's rule draws on an allowance in the same command that pays: that draw is what leaves the wallet.
  for (const p of ownPays) if (p.underRule) withdrawn += BigInt(p.underRule.withdrawalMinor);

  const items = signingItems(actions as Parameters<typeof signingItems>[0]);
  const kind = payments.length > 1 ? 'batch' : payments.length === 1 ? 'payment' : 'change';
  const steps = counted(items.filter((i) => !i.covered));
  // A change to the wallet is all steps, and the screen opens them. In a payment, a step that is not known bookkeeping is the alarm.
  const unexpected = kind === 'change' ? [] : counted(items.filter((item, i) => !isKnownInPayment(actions[i]) && !item.covered));

  // What leaves the wallet is exactly each payment and the most its fee may be. More is another payout; less is a transaction that cannot pay.
  let mismatch: string | null = null;
  let shape = false;
  if (kind !== 'change') {
    shape = opens.length !== ownPays.length;
    if (!shape) {
      const expected = opens.reduce((sum, o, i) => sum + BigInt(o.amountMinor) + BigInt(ownPays[i].maxFeeMinor), 0n);
      if (withdrawn > expected) mismatch = `More leaves the wallet than the payment and its fee: up to ${formatUsdc(withdrawn)} USDC, against ${formatUsdc(expected)} USDC.`;
      else if (withdrawn < expected) mismatch = `The wallet is asked for less than the payment and its fee, so this does not add up: ${formatUsdc(withdrawn)} USDC, against ${formatUsdc(expected)} USDC.`;
    }
  }

  const reasons: string[] = [];
  if (items.some((i) => i.unknown)) reasons.push('Part of this request cannot be shown here, so it cannot be signed from this screen.');
  if (unexpected.length > 0) reasons.push('This transaction also does something besides the payment it shows.');
  if (shape) reasons.push('A payment here is opened without being paid, or paid without being opened in this transaction.');
  if (mismatch) reasons.push(mismatch);
  if (rateProblem) reasons.push('The rate for this payment cannot be shown, so what is received cannot be checked.');

  return {
    kind,
    headline: kind === 'batch' ? `${payments.length} payments in one transaction` : kind === 'payment' ? `Pay ${payments[0].amount} USDC` : 'Change to your business wallet',
    asset: 'USDC',
    payments,
    leavesAtMost: withdraws.length > 0 || ownPays.some((p) => p.underRule) ? formatUsdc(withdrawn) : null,
    steps,
    unexpected,
    mismatch,
    blocked: reasons.length > 0,
    blockedReason: reasons.length > 0 ? reasons.join(' ') : null,
    code: review.code,
  };
}

/**
 * Word a device review. `names` are the payees' names the page knew, in the
 * order of the payments. It never throws: a request it cannot word is
 * blocked, with the reason, so the screen says do not sign and the person can
 * still decline it from the same page.
 */
export function approveFacts(review: DeviceReview, opts: { names?: Array<string | null | undefined> } = {}): ApproveFacts {
  try {
    return build(review, opts);
  } catch {
    return {
      kind: 'change',
      headline: 'This request could not be worded',
      asset: 'USDC',
      payments: [],
      leavesAtMost: null,
      steps: [],
      unexpected: [],
      mismatch: null,
      blocked: true,
      blockedReason: 'Part of this request cannot be shown here, so it cannot be signed from this screen.',
      code: review.code,
    };
  }
}

/** One line for a request's card in the inbox: what the screen would say, the same words, and a request that is not to be signed says so. */
export function cardSummary(facts: ApproveFacts): { text: string; warn: boolean } {
  if (facts.blocked) return { text: `Do not sign: ${facts.blockedReason ?? 'this request cannot be shown here.'}`, warn: true };
  if (facts.kind === 'batch') return { text: facts.headline, warn: false };
  if (facts.kind === 'payment') {
    const first = facts.payments[0];
    return { text: `${first.amount} USDC${first.kindLabel ? ` · ${first.kindLabel}` : ''}`, warn: false };
  }
  const more = facts.steps.length - 1;
  const first = facts.steps[0]?.line ?? facts.headline;
  return { text: more > 0 ? `${first} and ${more} more ${more === 1 ? 'change' : 'changes'}` : first, warn: false };
}

/** What the person is told after they decline or withdraw, in what actually happened. */
export function closeOutcomeText(outcome: string | undefined): string {
  if (outcome === 'cancelled') return 'You withdrew this request. Nothing was signed or sent.';
  if (outcome === 'declined_and_closed') return 'You declined this request. It can no longer reach enough signatures, so it is closed and nothing was sent.';
  return 'You declined this request. The other owners can still sign it.';
}

/** What a signing request looks like to the device: its bytes, the digest and hash it claims, and the ids it may touch. */
export type ReviewableRequest = { transactionBytes: string; digest: string; bytesHash: string; expect: unknown };

export type Reviewed = { ok: true; review: DeviceReview; facts: ApproveFacts } | { ok: false; message: string };

const COULD_NOT_CHECK = 'This request could not be checked on your device, so do not sign it.';

/**
 * Decode a request on the device and word it. Bytes whose digest or hash is
 * not the one the request names, or that do not decode, are not shown at all.
 */
export function reviewRequest(view: ReviewableRequest, opts: { names?: Array<string | null | undefined> } = {}): Reviewed {
  try {
    const review = reviewOnDevice({ transactionBytes: view.transactionBytes, digest: view.digest, bytesHash: view.bytesHash, expect: view.expect as Parameters<typeof reviewOnDevice>[0]['expect'] });
    return { ok: true, review, facts: approveFacts(review, opts) };
  } catch {
    return { ok: false, message: COULD_NOT_CHECK };
  }
}
