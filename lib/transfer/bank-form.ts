/**
 * The supplier's bank account form (v2 brief 5.4 step 2), as one rule for the
 * desktop form and the phone's one-question-at-a-time screens.
 *
 * What a person must give, in what words a missing field is refused, and the
 * request that saves the account. An account number is checked as an account
 * number and never as a Sui address (`checkPayeeField('bank', …)`), so "invalid
 * Sui address" cannot appear for a bank payout. The business is the session's:
 * nothing here names one.
 *
 * Pure and client-safe.
 */
import { checkPayeeField } from './addresses.ts';

export type BankForm = {
  holder: 'business' | 'person';
  country: string;
  holderName: string;
  registrationNumber: string;
  bankCode: string;
  accountNumber: string;
  street: string;
  city: string;
  postCode: string;
  relationship: string;
};

export const BANK_BLANK: BankForm = { holder: 'business', country: 'PH', holderName: '', registrationNumber: '', bankCode: '', accountNumber: '', street: '', city: '', postCode: '', relationship: 'supplier' };

export type BankErrors = Partial<Record<keyof BankForm | 'form', string>>;

/** Every field that is wrong, in the form's own words, and the account number as it is to be sent when it is right. */
export function validateBank(form: BankForm): { errors: BankErrors; accountAddress: string | null } {
  const errors: BankErrors = {};
  if (form.holderName.trim().length < 2) errors.holderName = 'Enter the name the bank holds on the account.';
  const account = checkPayeeField('bank', form.accountNumber);
  if (!account.ok) errors.accountNumber = account.message;
  if (!form.bankCode.trim()) errors.bankCode = 'Enter the bank code.';
  if (!form.city.trim()) errors.city = 'Enter the town or city.';
  if (form.holder === 'business' && !form.registrationNumber.trim()) errors.registrationNumber = 'Enter the company registration number.';
  return { errors, accountAddress: account.ok ? account.address : null };
}

/** The request that saves the account: the name, the bank, the number and the address, and a business's registration. */
export function beneficiaryBody(form: BankForm, accountAddress: string) {
  return {
    holderName: form.holderName.trim(),
    country: form.country,
    bankCode: form.bankCode.trim(),
    accountNumber: accountAddress,
    address: { streetName: form.street.trim() || undefined, postCode: form.postCode.trim() || undefined, townName: form.city.trim(), country: form.country },
    registrationNumber: form.holder === 'business' ? form.registrationNumber.trim() : undefined,
    registrationScheme: form.holder === 'business' ? ('CINC' as const) : undefined,
    relationship: form.relationship,
  };
}
