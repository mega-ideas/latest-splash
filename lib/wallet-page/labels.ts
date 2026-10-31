/**
 * The words on the Wallet page (v2 brief 5.5) for deposits, funding sources,
 * withdrawals and signing requests. Pure and client-safe. Each line says what
 * is true and what to do next. No licence claim, no partner name (partner
 * names come only from lib/partners/signed-partners.ts), no internal code.
 */
import { formatUsdc } from '../fees/copy.ts';

export type Tone = 'ok' | 'wait' | 'bad';

// ─── Deposits ───────────────────────────────────────────────────────────────

/** The same sentences the server gives (lib/funding/wallet-funding.ts HOLD_REASON_TEXT); a test keeps them equal. */
const HOLD_REASONS: Record<string, string> = {
  source_unknown: 'We could not tell which of your funding sources sent this.',
  source_unverified: 'It came from a funding source your business has not verified yet.',
  first_use_failed: 'The first payment from this source did not match your business.',
  payer_mismatch: 'The payer the provider reported is not the source this top-up named.',
  origin_unconfirmed: 'It came through a swap route, and which wallet sent it on the other chain is not confirmed yet.',
  mint_unattributable: 'It arrived with a CCTP mint that could not be matched to one transfer to this wallet, so who sent it is not confirmed.',
  not_screened: 'It has not been screened yet. It is screened again when you ask.',
  screening_review: 'Screening asked for a closer look before it can be used.',
};

export function holdReasonText(reason: string): string {
  return HOLD_REASONS[reason] ?? 'It is being checked before it can be used.';
}

export type DepositFacts = { asset: string; amountMinor: string; status: string; holdReasons: string[]; arrivedAt: string | null };

export type DepositLine = { amount: string; asset: string; state: string; tone: Tone; reasons: string[]; note: string; when: string | null };

const COIN: Record<string, string> = { USDC: 'USDC', USDT: 'USDT', USDSUI: 'USDsui' };

export function depositLine(d: DepositFacts): DepositLine {
  const coin = COIN[d.asset.toUpperCase()] ?? d.asset;
  const amount = `${formatUsdc(BigInt(d.amountMinor))} ${coin}`;
  const other = d.asset.toUpperCase() !== 'USDC';
  const conversion = other ? `Arrived as ${coin}. It is not counted as USDC, and it stays in your wallet as it is.` : '';
  if (d.status === 'blocked') {
    return { amount, asset: coin, state: 'Blocked', tone: 'bad', reasons: [], note: 'Screening blocked this deposit and it will not be spent. Contact support to ask for a review.', when: d.arrivedAt };
  }
  if (d.status === 'held') {
    return { amount, asset: coin, state: 'Held, not spent', tone: 'wait', reasons: d.holdReasons.map(holdReasonText), note: conversion, when: d.arrivedAt };
  }
  return { amount, asset: coin, state: 'Ready to use', tone: 'ok', reasons: [], note: conversion, when: d.arrivedAt };
}

/** USDC arrivals, and the other coins that arrive and wait to be converted, each with its own list. Each line keeps the deposit it was made from. */
export function fundingHistory<T extends DepositFacts>(deposits: T[]): { usdc: Array<DepositLine & { item: T }>; converted: Array<DepositLine & { item: T }> } {
  const lines = deposits.map((d) => ({ ...depositLine(d), item: d }));
  return {
    usdc: lines.filter((l) => l.item.asset.toUpperCase() === 'USDC'),
    converted: lines.filter((l) => l.item.asset.toUpperCase() !== 'USDC'),
  };
}

// ─── Funding sources ────────────────────────────────────────────────────────

export type SourceFacts = { kind: string; status: string; last4: string | null; label: string };

export function sourceLine(s: SourceFacts): { name: string; kindLabel: string; state: string; tone: Tone; next: string } {
  const kindLabel = s.kind === 'bank_account' ? 'Bank account' : s.kind === 'card' ? 'Card' : 'Wallet';
  const name = `${s.label}${s.last4 ? ` ••${s.last4}` : ''}`;
  if (s.status === 'verified') return { name, kindLabel, state: 'Verified', tone: 'ok', next: '' };
  if (s.status === 'pending') {
    const next = s.kind === 'wallet' ? 'Sign Splash’s message with this wallet to prove you control it.' : 'It is checked once, on its first deposit, against your company’s name.';
    return { name, kindLabel, state: 'Checking', tone: 'wait', next };
  }
  if (s.status === 'rejected') return { name, kindLabel, state: 'Not accepted', tone: 'bad', next: 'It did not match your business. Add the account that is in your company’s name.' };
  return { name, kindLabel, state: 'Removed', tone: 'bad', next: 'Add it again to use it; it will be checked again.' };
}

// ─── Withdrawals ────────────────────────────────────────────────────────────

export function withdrawalLine(status: string): { state: string; tone: Tone; note: string } {
  switch (status) {
    case 'preparing':
      return { state: 'Being prepared', tone: 'wait', note: 'Splash is setting this withdrawal up.' };
    case 'awaiting_signatures':
      return { state: 'Waiting for your owners to sign', tone: 'wait', note: 'Nothing leaves your wallet until enough owners have signed.' };
    case 'sent':
      return { state: 'Sent, waiting for the bank partner', tone: 'wait', note: 'The USDC has left your wallet and is with the partner.' };
    case 'partner_received':
      return { state: 'Received, paying out', tone: 'wait', note: 'The partner has your USDC and is paying your bank account.' };
    case 'paid_out':
      return { state: 'Paid to your bank', tone: 'ok', note: '' };
    case 'failed':
      return { state: 'Did not complete', tone: 'bad', note: 'The partner is returning the USDC to your wallet.' };
    case 'returned':
      return { state: 'USDC returned', tone: 'bad', note: 'The USDC is back in your wallet.' };
    case 'cancelled':
      return { state: 'Cancelled', tone: 'bad', note: 'Nothing was sent.' };
    default:
      return { state: 'In progress', tone: 'wait', note: '' };
  }
}

// ─── Signing requests ───────────────────────────────────────────────────────

const TITLES: Record<string, string> = {
  nominate_wallet: 'Start your business wallet',
  register_wallet: 'Create your business wallet',
  rotate_wallet: 'Change who signs for your business wallet',
  confirm_wallet_rotation: 'Confirm the new signers',
  cancel_wallet_rotation: 'Withdraw the change of signers',
  wallet_membership: 'Change who owns the business account',
  wallet_payment: 'Approve a payment from your business wallet',
  wallet_batch: 'Approve a batch of payments from your business wallet',
  migration_transfer: 'Move your USDC to your business wallet',
  rotation_transfer: 'Move the USDC to the new business wallet',
  spend_policy: 'Set up spending rules',
  spend_rule: 'Change a spending rule',
  spend_approval: 'Give a second approval',
  withdrawal: 'Approve a withdrawal to your bank',
  partner_test_deposit: 'Send the small test deposit',
  partner_payout: 'Approve a payment to a supplier’s bank',
  subscription: 'Change your billing allowance',
};

export function requestTitle(purpose: string): string {
  return TITLES[purpose] ?? 'Approve a change to your business wallet';
}
