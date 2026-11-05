/**
 * Transfer on a phone asks one question per screen (v2 brief 5.10).
 *
 * The desktop flow has five steps (who, details, amount and pay from, review
 * and approve, receipt). On a phone each step is split into the questions it
 * is made of, and only the questions that apply are asked: a business on
 * Splash has no bank form, a person has no company number, a wallet has no
 * purpose of payment. This module is the order of those screens and what each
 * needs before "Continue", as data, so it is tested without a browser.
 *
 * The five steps stay the unit the draft is kept by (a payment's step, 1 to
 * 5): `stepOf` says which step a screen belongs to, and `defaultScreen` where
 * a step opens. Nothing here moves money or makes an intent id: it only says
 * which screen is next.
 *
 * Pure and client-safe.
 */
import { checkPayeeField } from './addresses.ts';
import { corridorAccess, type PayeeKind } from './payee.ts';
import { parseAmountMinor } from './plan.ts';
import type { BankForm } from './bank-form.ts';

export type Screen =
  | 'who'
  | 'supplier'
  | 'business'
  | 'address'
  | 'b.country'
  | 'b.holder'
  | 'b.name'
  | 'b.registration'
  | 'b.bank'
  | 'b.account'
  | 'b.city'
  | 'b.relationship'
  | 'b.confirm'
  | 'amount'
  | 'purpose'
  | 'source'
  | 'reference'
  | 'review'
  | 'receipt';

export type PhoneState = {
  payeeType: PayeeKind | null;
  /** Adding a new supplier account. Only an owner adds one: for anyone else the questions are never asked. */
  adding: boolean;
  holder: 'business' | 'person';
  owner: boolean;
};

/** Every screen of one payment, in order, for what has been chosen so far. */
export function screensFor(state: PhoneState): Screen[] {
  if (state.payeeType === null) return ['who'];
  if (state.payeeType === 'splash_business') return ['who', 'business', 'amount', 'reference', 'review', 'receipt'];
  if (state.payeeType === 'wallet') return ['who', 'address', 'amount', 'reference', 'review', 'receipt'];
  const form: Screen[] =
    state.adding && state.owner
      ? ['b.country', 'b.holder', 'b.name', ...(state.holder === 'business' ? (['b.registration'] as Screen[]) : []), 'b.bank', 'b.account', 'b.city', 'b.relationship', 'b.confirm']
      : [];
  return ['who', 'supplier', ...form, 'amount', 'purpose', 'source', 'reference', 'review', 'receipt'];
}

export type Step = 1 | 2 | 3 | 4 | 5;

/** The desktop step a screen belongs to: what the draft and the receipt are kept by. */
export function stepOf(screen: Screen): Step {
  if (screen === 'who') return 1;
  if (screen === 'supplier' || screen === 'business' || screen === 'address' || screen.startsWith('b.')) return 2;
  if (screen === 'amount' || screen === 'purpose' || screen === 'source' || screen === 'reference') return 3;
  return screen === 'review' ? 4 : 5;
}

/** Where a step opens: its first question. */
export function defaultScreen(step: Step, state: PhoneState): Screen {
  if (step === 1) return 'who';
  if (step === 2) return state.payeeType === 'splash_business' ? 'business' : state.payeeType === 'wallet' ? 'address' : 'supplier';
  if (step === 3) return 'amount';
  return step === 4 ? 'review' : 'receipt';
}

export function nextScreen(screen: Screen, state: PhoneState): Screen | null {
  const list = screensFor(state);
  const at = list.indexOf(screen);
  return at === -1 ? null : (list[at + 1] ?? null);
}

/** Back is never into the receipt's past: a paid payment is not walked back into. */
export function prevScreen(screen: Screen, state: PhoneState): Screen | null {
  if (screen === 'receipt') return null;
  const list = screensFor(state);
  const at = list.indexOf(screen);
  return at <= 0 ? null : list[at - 1];
}

/** "Question 3 of 7": the questions before the receipt, and never past the last. */
export function progressOf(screen: Screen, state: PhoneState): { n: number; of: number } {
  const list: Screen[] = screensFor(state).filter((s) => s !== 'receipt');
  const at = list.indexOf(screen);
  return { n: at === -1 ? list.length : at + 1, of: list.length };
}

type ChosenLike = { kind: 'bank' | 'splash_business' | 'recipient'; blocked?: string | null } | null;

export type ReadyInput = {
  payeeType: PayeeKind | null;
  chosen: ChosenLike;
  amountText: string;
  purposeCode: string;
  sourceOfFunds: string;
  /** The wallet covers the amount and the fee; false while it is short, unknown or not read. */
  fundsOk: boolean;
  bank: BankForm;
};

/** Whether a screen's own question is answered, so "Continue" may be pressed. */
export function screenReady(screen: Screen, input: ReadyInput): boolean {
  const b = input.bank;
  switch (screen) {
    case 'who':
      return input.payeeType !== null;
    case 'supplier':
      return input.chosen?.kind === 'bank';
    case 'business':
      return input.chosen?.kind === 'splash_business';
    case 'address':
      return input.chosen?.kind === 'recipient' && !input.chosen.blocked;
    case 'b.country':
      return corridorAccess(b.country) === 'live';
    case 'b.name':
      return b.holderName.trim().length >= 2;
    case 'b.registration':
      return b.registrationNumber.trim() !== '';
    case 'b.bank':
      return b.bankCode.trim() !== '';
    case 'b.account':
      return checkPayeeField('bank', b.accountNumber).ok;
    case 'b.city':
      return b.city.trim() !== '';
    case 'amount':
      return parseAmountMinor(input.amountText) !== null && input.fundsOk;
    case 'purpose':
      return input.purposeCode !== '';
    case 'source':
      return input.sourceOfFunds !== '';
    default:
      // b.holder, b.relationship and b.confirm have an answer already; the reference is optional; review and receipt have their own actions.
      return true;
  }
}
