import { beneficiaryBody, validateBank, type BankErrors, type BankForm } from '@/lib/transfer/bank-form';
import { call, errorText, type Beneficiary } from './api';

/**
 * Save a supplier's bank account: the one save the desktop form and the
 * phone's questions both use. The fields are checked first (nothing is sent
 * when one is wrong); the server checks the account with the bank before it
 * keeps it, stores the number sealed, and takes the business from the
 * session. A failure is a sentence, and nothing was sent.
 */
export async function saveBeneficiary(form: BankForm): Promise<{ ok: true; beneficiary: Beneficiary } | { ok: false; errors: BankErrors }> {
  const { errors, accountAddress } = validateBank(form);
  if (Object.keys(errors).length > 0 || accountAddress === null) return { ok: false, errors };
  const answer = await call<{ beneficiary?: Beneficiary }>('/api/wallet/payouts/beneficiaries', { body: beneficiaryBody(form, accountAddress) });
  if (!answer.ok || !answer.body?.beneficiary) return { ok: false, errors: { form: errorText(answer, 'The account could not be saved. Nothing was sent.') } };
  return { ok: true, beneficiary: answer.body.beneficiary };
}
