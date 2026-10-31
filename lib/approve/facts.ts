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
  /** A command the screen cannot word is never signed. */
  blocked: boolean;
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

/** Word a device review. `names` are the payees' names the page knew, in the order of the payments. */
export function approveFacts(review: DeviceReview, opts: { names?: Array<string | null | undefined> } = {}): ApproveFacts {
  const opens = review.actions.filter((a) => a.type === 'open_intent');
  const pays = review.actions.filter((a) => a.type === 'pay_intent');
  const withdraws = review.actions.filter((a) => a.type === 'withdraw');

  const payments: ApprovePayment[] = opens.flatMap((open, i) => {
    if (open.type !== 'open_intent') return [];
    const pay = pays[i];
    const currency = open.targetCurrency;
    const hasRate = !USD_LIKE.has(currency.toUpperCase()) && BigInt(open.fxRateUsdLocal) > 0n;
    return [
      {
        payeeName: opts.names?.[i] ?? null,
        recipient: addressOf(open.recipient),
        amount: safeUsdc(open.amountMinor) ?? 'an amount',
        maxFee: pay && pay.type === 'pay_intent' ? safeUsdc(pay.maxFeeMinor) : null,
        kindLabel: kindText(open.kind),
        rate: hasRate ? { currency, text: `1 USDC = ${rateText(open.fxRateUsdLocal)} ${currency}`, receiveApprox: receiveApprox(open.amountMinor, open.fxRateUsdLocal, currency) } : null,
      },
    ];
  });

  let withdrawn = 0n;
  for (const w of withdraws) if (w.type === 'withdraw') withdrawn += BigInt(w.amountMinor);

  const items = signingItems(review.actions as Parameters<typeof signingItems>[0]);
  // A batch repeats the same few commands once per payment: each is said once, with how many times.
  const counted = new Map<string, { item: ShownAction; times: number }>();
  for (const item of items.filter((i) => !i.covered)) {
    const key = `${item.line}|${item.fields.map((f) => `${f.label}=${f.value}`).join(';')}`;
    const seen = counted.get(key);
    if (seen) seen.times += 1;
    else counted.set(key, { item, times: 1 });
  }
  const steps = [...counted.values()].map(({ item, times }) => (times > 1 ? { ...item, line: `${item.line.replace(/\.$/, '')}, ${times} times, once for each payment.` } : item));

  const kind = payments.length > 1 ? 'batch' : payments.length === 1 ? 'payment' : 'change';
  return {
    kind,
    headline: kind === 'batch' ? `${payments.length} payments in one transaction` : kind === 'payment' ? `Pay ${payments[0].amount} USDC` : 'Change to your business wallet',
    asset: 'USDC',
    payments,
    leavesAtMost: withdraws.length > 0 ? formatUsdc(withdrawn) : null,
    steps,
    blocked: items.some((i) => i.unknown),
    code: review.code,
  };
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
