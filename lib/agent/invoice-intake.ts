/**
 * Reading an invoice into a beneficiary the user then approves.
 *
 * ─── What this does and does not decide ─────────────────────────────────────
 *
 * 0xWal reads the invoice and proposes a beneficiary record. It does not create
 * one. Every field it extracted is shown back with the source it came from, and
 * a person confirms before anything is saved.
 *
 * That is not politeness. A beneficiary record is the thing a partner files a
 * travel-rule report against and the thing every future payment to that company
 * routes through. A model that silently writes one has silently decided where
 * money goes, on the strength of an OCR pass over a PDF somebody emailed. The
 * confirmation is the control.
 *
 * ─── Incomplete is the normal case, not the error case ──────────────────────
 *
 * Invoices carry a name, an amount and usually a bank account. They rarely
 * carry a registered address, a company registration number or the corridor's
 * routing identifier — and those are exactly what FATF R.16 requires. So the
 * expected outcome is "here is what I found, here is what is still needed", and
 * the missing list comes from the same engine the form and the authorize route
 * use, so it cannot ask for a different set than the ones that will be enforced.
 */
import type { BeneficiaryRecord } from '@/lib/compliance/travel-rule';

export type ExtractedField = {
  field: string;
  label: string;
  value: string;
  /** Where it came from, so a person can check the one that looks wrong. */
  source: 'invoice-text' | 'existing-record' | 'inferred';
  /** Inferred values are the ones worth a second look. */
  confident: boolean;
};

export type InvoiceIntake = {
  status: 'READY_TO_CONFIRM' | 'NEEDS_MORE';
  /** The beneficiary as read. Never saved without confirmation. */
  draft: BeneficiaryRecord & { name?: string; country?: string };
  extracted: ExtractedField[];
  /** What the corridor still requires, in the payer's words, each with a reason. */
  missing: Array<{ field: string; label: string; because: string }>;
  /** What 0xWal should say next. */
  ask: string;
};

const LABELS: Record<string, string> = {
  name: 'Trading name',
  legalName: 'Registered legal name',
  registrationNumber: 'Company registration number',
  addressLine1: 'Street address',
  addressCity: 'City',
  addressCountry: 'Country',
  bankName: 'Bank name',
  bankIdValue: 'Bank routing identifier',
  bankAccountNumber: 'Account number',
  bankAccountName: 'Account holder name',
};

/**
 * Turn what was read off an invoice into a proposed beneficiary.
 *
 * `existing` is passed when the beneficiary is already saved and this invoice
 * is filling gaps — that path updates rather than duplicates, because two
 * records for one company means two screening histories and a payment that can
 * route through whichever one is less complete.
 */
export async function prepareBeneficiaryFromInvoice(input: {
  orgId: string;
  destinationCountry: string;
  /** Fields the extraction produced. */
  read: Partial<BeneficiaryRecord> & { name?: string };
  existing?: (Partial<BeneficiaryRecord> & { name?: string }) | null;
}): Promise<InvoiceIntake> {
  const { missingTravelRuleFields } = await import('@/lib/compliance/travel-rule');
  const { readOriginator } = await import('@/lib/server/originator');

  // An existing record wins on any field it already holds: it was screened,
  // and an invoice is not a reason to overwrite a verified address with an OCR
  // reading of one.
  const draft = { ...input.read, ...pruneEmpty(input.existing ?? {}) };

  const extracted: ExtractedField[] = Object.entries(draft)
    .filter(([, value]) => typeof value === 'string' && value.trim().length > 0)
    .map(([field, value]) => ({
      field,
      label: LABELS[field] ?? field,
      value: String(value),
      source: pruneEmpty(input.existing ?? {})[field] !== undefined
        ? ('existing-record' as const)
        : ('invoice-text' as const),
      confident: true,
    }));

  const { originator } = await readOriginator(input.orgId);
  const missing = missingTravelRuleFields({
    destinationCountry: input.destinationCountry,
    beneficiary: draft,
    originator,
    payment: {},
  })
    // The payer's own half is fixed in the business profile, not by answering
    // questions about somebody else's invoice.
    .filter((item) => !item.field.startsWith('originator.'));

  const beneficiaryGaps = missing.filter((item) => item.field.startsWith('beneficiary.'));

  return {
    status: beneficiaryGaps.length === 0 ? 'READY_TO_CONFIRM' : 'NEEDS_MORE',
    draft,
    extracted,
    missing,
    ask:
      beneficiaryGaps.length === 0
        ? 'I have everything this corridor needs. Shall I add them to your recipients?'
        : askFor(beneficiaryGaps),
  };
}

function pruneEmpty(record: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(record)) {
    if (typeof value === 'string' && value.trim().length > 0) out[key] = value.trim();
  }
  return out;
}

/**
 * Ask for what is missing, one or two things at a time.
 *
 * Not a list of nine. A person handed nine questions in a chat box answers
 * three and abandons it, and an abandoned beneficiary is one that gets created
 * incomplete later by someone in a hurry.
 */
function askFor(missing: Array<{ label: string; because: string }>): string {
  const first = missing[0];
  const rest = missing.length - 1;
  const tail =
    rest > 0
      ? ` After that I will need ${rest} more thing${rest === 1 ? '' : 's'} before they can be paid.`
      : '';
  return `I still need the ${first.label.toLowerCase()}. ${first.because}${tail}`;
}
