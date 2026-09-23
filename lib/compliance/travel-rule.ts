/**
 * FATF Recommendation 16 — the travel rule — and what each corridor's banks
 * actually demand on top of it.
 *
 * Two different obligations sit here, and conflating them is how products end
 * up collecting the wrong fields:
 *
 *   R.16 is about what must TRAVEL WITH the payment. For a cross-border wire:
 *   the originator's name, account number, and one of {address, national ID,
 *   customer ID, date and place of birth}; and the beneficiary's name and
 *   account number. It is a transmission requirement, not a storage one.
 *
 *   The CORRIDOR requirements are what the receiving bank needs to route and
 *   to satisfy its own regulator — a bank code for PESONet, an IBAN for SEPA,
 *   a purpose-of-payment code for BNM and BSP. Miss one and the payment is
 *   returned days later, which is worse than refusing it at the desk.
 *
 * The rules below are the requirements as a payout partner states them at
 * onboarding. They are deliberately DATA, not branches: a corridor is added by
 * adding a row, and every rule is visible in one place to whoever has to
 * defend it to a regulator.
 *
 * What this file does NOT do: decide whether a payment is allowed. It decides
 * whether we hold enough information to make it. Sanctions screening,
 * thresholds and limits live elsewhere.
 */

/** ISO 3166-1 alpha-2. */
export type CountryCode = string;

export type BankIdScheme =
  | 'SWIFT_BIC'
  | 'IBAN'
  | 'LOCAL_BANK_CODE'
  | 'GB_SORT_CODE'
  | 'US_ROUTING_ABA'
  | 'AU_BSB'
  | 'IN_IFSC'
  | 'PROXY_ID';

export type BeneficiaryType = 'INDIVIDUAL' | 'BUSINESS';

/** The beneficiary as stored. Every field optional — that is the point. */
export type BeneficiaryRecord = {
  name?: string | null;
  legalName?: string | null;
  beneficiaryType?: BeneficiaryType | null;
  registrationNumber?: string | null;
  dateOfBirth?: string | null;
  nationalIdNumber?: string | null;
  addressLine1?: string | null;
  addressCity?: string | null;
  addressState?: string | null;
  addressPostalCode?: string | null;
  addressCountry?: string | null;
  bankName?: string | null;
  bankIdScheme?: BankIdScheme | null;
  bankIdValue?: string | null;
  bankBranchCode?: string | null;
  bankCountry?: string | null;
  bankAccountNumber?: string | null;
  bankAccountName?: string | null;
};

/** The payer, from the org's KYB record. R.16's originator half. */
export type OriginatorRecord = {
  legalName?: string | null;
  registrationNumber?: string | null;
  addressLine1?: string | null;
  addressCity?: string | null;
  addressCountry?: string | null;
  accountReference?: string | null;
};

/** Context that belongs to the payment rather than the beneficiary. */
export type PaymentContext = {
  purposeCode?: string | null;
  purposeDescription?: string | null;
  sourceOfFunds?: string | null;
  beneficiaryRelationship?: string | null;
};

export type FieldRequirement = {
  /** Dotted path into the beneficiary/originator/payment object. */
  field: string;
  /** What to tell the person filling the form. Never a field name. */
  label: string;
  /** Why this corridor asks. Shown on hover; it is the answer to "why?". */
  because: string;
};

export type CorridorRule = {
  country: CountryCode;
  currency: string;
  /** The scheme this corridor routes on, in preference order. */
  bankIdSchemes: BankIdScheme[];
  /** True when a separate branch code is part of routing (not folded into the bank code). */
  requiresBranchCode: boolean;
  /** True when the receiving regulator requires a purpose-of-payment code. */
  requiresPurposeCode: boolean;
  /** Local account number needed in addition to the scheme identifier. */
  requiresAccountNumber: boolean;
  /** Human note for the operator, carried into the UI. */
  note: string;
};

/**
 * Per-corridor rules.
 *
 * `requiresAccountNumber` is false only where the scheme identifier IS the
 * account — IBAN encodes it, so asking for both invites a mismatch.
 */
export const CORRIDOR_RULES: Record<CountryCode, CorridorRule> = {
  PH: {
    country: 'PH',
    currency: 'PHP',
    bankIdSchemes: ['LOCAL_BANK_CODE', 'SWIFT_BIC'],
    requiresBranchCode: false,
    requiresPurposeCode: true,
    requiresAccountNumber: true,
    note: 'PESONet and InstaPay route on the local bank code. BSP requires a purpose of payment on inbound remittance.',
  },
  MY: {
    country: 'MY',
    currency: 'MYR',
    bankIdSchemes: ['SWIFT_BIC'],
    requiresBranchCode: false,
    requiresPurposeCode: true,
    requiresAccountNumber: true,
    note: 'RENTAS and DuitNow route on SWIFT. BNM requires a purpose-of-payment code on inbound cross-border transfers.',
  },
  ID: {
    country: 'ID',
    currency: 'IDR',
    bankIdSchemes: ['LOCAL_BANK_CODE', 'SWIFT_BIC'],
    requiresBranchCode: false,
    requiresPurposeCode: true,
    requiresAccountNumber: true,
    note: 'BI-FAST routes on the Sandi Bank code. Bank Indonesia requires a declared purpose on inbound transfers.',
  },
  SG: {
    country: 'SG',
    currency: 'SGD',
    bankIdSchemes: ['SWIFT_BIC', 'PROXY_ID'],
    requiresBranchCode: true,
    requiresPurposeCode: false,
    requiresAccountNumber: true,
    note: 'FAST routes on bank plus branch code; PayNow accepts a proxy (mobile or UEN) instead.',
  },
  TH: {
    country: 'TH',
    currency: 'THB',
    bankIdSchemes: ['LOCAL_BANK_CODE', 'SWIFT_BIC'],
    requiresBranchCode: true,
    requiresPurposeCode: true,
    requiresAccountNumber: true,
    note: 'PromptPay and BAHTNET route on the bank code; BOT requires a purpose code on inbound.',
  },
  VN: {
    country: 'VN',
    currency: 'VND',
    bankIdSchemes: ['LOCAL_BANK_CODE', 'SWIFT_BIC'],
    requiresBranchCode: false,
    requiresPurposeCode: true,
    requiresAccountNumber: true,
    note: 'Napas routes on the local bank code. SBV requires a stated purpose and supporting document reference on inbound.',
  },
  GB: {
    country: 'GB',
    currency: 'GBP',
    bankIdSchemes: ['GB_SORT_CODE', 'IBAN', 'SWIFT_BIC'],
    requiresBranchCode: false,
    requiresPurposeCode: false,
    requiresAccountNumber: true,
    note: 'Faster Payments routes on sort code plus account number; IBAN is accepted for international.',
  },
  EU: {
    country: 'EU',
    currency: 'EUR',
    bankIdSchemes: ['IBAN'],
    requiresBranchCode: false,
    requiresPurposeCode: false,
    requiresAccountNumber: false,
    note: 'SEPA routes on IBAN, which encodes the account — a separate account number is not asked for.',
  },
};

/** Corridors we hold rules for. Anything else is refused rather than guessed. */
export function supportedCorridors(): CountryCode[] {
  return Object.keys(CORRIDOR_RULES);
}

export function corridorRule(country: string | null | undefined): CorridorRule | null {
  if (!country) return null;
  return CORRIDOR_RULES[country.trim().toUpperCase()] ?? null;
}

const present = (value: unknown): boolean =>
  typeof value === 'string' ? value.trim().length > 0 : value !== null && value !== undefined;

/**
 * What is still missing before this payment can be sent.
 *
 * Returns an empty array when the record is complete. Each entry names the
 * field, what to call it on screen, and why the corridor asks — so a form can
 * render the reason rather than an error code, and an operator can answer
 * "why do you need my date of birth?" without opening a regulation.
 */
export function missingTravelRuleFields(input: {
  destinationCountry: string;
  beneficiary: BeneficiaryRecord;
  originator: OriginatorRecord;
  payment: PaymentContext;
}): FieldRequirement[] {
  const rule = corridorRule(input.destinationCountry);
  const missing: FieldRequirement[] = [];
  const { beneficiary: b, originator: o, payment: p } = input;

  // ── R.16: the originator half. Name, account, and ONE identifier. ────────
  if (!present(o.legalName)) {
    missing.push({
      field: 'originator.legalName',
      label: 'Your registered legal name',
      because: 'The travel rule requires the sender’s name to accompany the payment.',
    });
  }
  if (!present(o.accountReference)) {
    missing.push({
      field: 'originator.accountReference',
      label: 'Your account reference',
      because: 'The travel rule requires an originator account number or a unique transaction reference.',
    });
  }
  const originatorIdentified =
    present(o.addressLine1) || present(o.registrationNumber);
  if (!originatorIdentified) {
    missing.push({
      field: 'originator.addressLine1',
      label: 'Your registered address',
      because:
        'The travel rule requires one identifier beyond the name — an address or a registration number.',
    });
  }

  // ── R.16: the beneficiary half. ──────────────────────────────────────────
  if (!present(b.name) && !present(b.legalName)) {
    missing.push({
      field: 'beneficiary.legalName',
      label: 'Beneficiary legal name',
      because: 'The travel rule requires the beneficiary’s name to accompany the payment.',
    });
  }

  // ── Identity, which differs by beneficiary type ──────────────────────────
  if (b.beneficiaryType === 'BUSINESS' && !present(b.registrationNumber)) {
    missing.push({
      field: 'beneficiary.registrationNumber',
      label: 'Company registration number',
      because: 'Partner banks match a business beneficiary against its registry entry.',
    });
  }
  if (b.beneficiaryType === 'INDIVIDUAL' && !present(b.dateOfBirth) && !present(b.nationalIdNumber)) {
    missing.push({
      field: 'beneficiary.dateOfBirth',
      label: 'Date of birth or national ID',
      because:
        'Screening an individual against a sanctions list on name alone produces false matches; one more identifier resolves them.',
    });
  }
  if (!present(b.beneficiaryType)) {
    missing.push({
      field: 'beneficiary.beneficiaryType',
      label: 'Individual or business',
      because: 'The identifying documents a partner requires differ between the two.',
    });
  }

  // ── Address ──────────────────────────────────────────────────────────────
  if (!present(b.addressLine1) || !present(b.addressCity) || !present(b.addressCountry)) {
    missing.push({
      field: 'beneficiary.addressLine1',
      label: 'Beneficiary address',
      because: 'Receiving banks in every supported corridor require a beneficiary address on inbound wires.',
    });
  }

  // ── Bank routing, per corridor ───────────────────────────────────────────
  if (!rule) {
    missing.push({
      field: 'beneficiary.bankCountry',
      label: 'A supported destination country',
      because: `Splash holds routing rules for ${supportedCorridors().join(', ')}. Sending elsewhere would be guessing at the identifier the receiving bank needs.`,
    });
    return missing;
  }

  if (!present(b.bankName)) {
    missing.push({
      field: 'beneficiary.bankName',
      label: 'Bank name',
      because: 'Named on the payment instruction and used to confirm the routing identifier resolves to the same bank.',
    });
  }
  if (!present(b.bankIdScheme) || !present(b.bankIdValue)) {
    missing.push({
      field: 'beneficiary.bankIdValue',
      label: schemeLabel(rule.bankIdSchemes[0]),
      because: rule.note,
    });
  } else if (!rule.bankIdSchemes.includes(b.bankIdScheme as BankIdScheme)) {
    missing.push({
      field: 'beneficiary.bankIdScheme',
      label: schemeLabel(rule.bankIdSchemes[0]),
      because: `${input.destinationCountry} routes on ${rule.bankIdSchemes.map(schemeLabel).join(' or ')}. ${rule.note}`,
    });
  }
  if (rule.requiresBranchCode && !present(b.bankBranchCode)) {
    missing.push({
      field: 'beneficiary.bankBranchCode',
      label: 'Branch code',
      because: rule.note,
    });
  }
  if (rule.requiresAccountNumber && !present(b.bankAccountNumber)) {
    missing.push({
      field: 'beneficiary.bankAccountNumber',
      label: 'Account number',
      because: 'The local account the funds credit to.',
    });
  }
  if (!present(b.bankAccountName)) {
    missing.push({
      field: 'beneficiary.bankAccountName',
      label: 'Account holder name, as the bank has it',
      because:
        'Receiving banks reject on a name mismatch, and the registered name is often not what the account is titled.',
    });
  }

  // ── Payment context ──────────────────────────────────────────────────────
  if (rule.requiresPurposeCode && !present(p.purposeCode)) {
    missing.push({
      field: 'payment.purposeCode',
      label: 'Purpose of payment',
      because: rule.note,
    });
  }
  if (!present(p.sourceOfFunds)) {
    missing.push({
      field: 'payment.sourceOfFunds',
      label: 'Source of funds',
      because: 'Asked by partner banks on cross-border business payments as part of ongoing due diligence.',
    });
  }
  if (!present(p.beneficiaryRelationship)) {
    missing.push({
      field: 'payment.beneficiaryRelationship',
      label: 'Your relationship to the beneficiary',
      because: 'Distinguishes a supplier payment from a related-party transfer, which are screened differently.',
    });
  }

  return missing;
}

export function schemeLabel(scheme: BankIdScheme): string {
  switch (scheme) {
    case 'SWIFT_BIC':
      return 'SWIFT / BIC';
    case 'IBAN':
      return 'IBAN';
    case 'LOCAL_BANK_CODE':
      return 'Bank code';
    case 'GB_SORT_CODE':
      return 'Sort code';
    case 'US_ROUTING_ABA':
      return 'Routing number (ABA)';
    case 'AU_BSB':
      return 'BSB';
    case 'IN_IFSC':
      return 'IFSC';
    case 'PROXY_ID':
      return 'PayNow proxy (mobile or UEN)';
  }
}

/**
 * The record of what travelled with a payment, frozen at authorization.
 *
 * A snapshot rather than a join: R.16 is about what accompanied THIS transfer,
 * and a beneficiary edited next week must not silently rewrite the history of a
 * payment already sent.
 */
export function travelRuleSnapshot(input: {
  destinationCountry: string;
  beneficiary: BeneficiaryRecord;
  originator: OriginatorRecord;
  payment: PaymentContext;
}): Record<string, unknown> {
  const { beneficiary: b, originator: o, payment: p } = input;
  return {
    version: 1,
    standard: 'FATF-R16',
    destinationCountry: input.destinationCountry,
    originator: {
      legalName: o.legalName ?? null,
      registrationNumber: o.registrationNumber ?? null,
      address: [o.addressLine1, o.addressCity, o.addressCountry].filter(Boolean).join(', ') || null,
      accountReference: o.accountReference ?? null,
    },
    beneficiary: {
      legalName: b.legalName ?? b.name ?? null,
      type: b.beneficiaryType ?? null,
      registrationNumber: b.registrationNumber ?? null,
      address:
        [b.addressLine1, b.addressCity, b.addressState, b.addressPostalCode, b.addressCountry]
          .filter(Boolean)
          .join(', ') || null,
      bankName: b.bankName ?? null,
      bankIdScheme: b.bankIdScheme ?? null,
      bankIdValue: b.bankIdValue ?? null,
      bankBranchCode: b.bankBranchCode ?? null,
      bankCountry: b.bankCountry ?? null,
      accountNumber: b.bankAccountNumber ?? null,
      accountName: b.bankAccountName ?? null,
    },
    payment: {
      purposeCode: p.purposeCode ?? null,
      purposeDescription: p.purposeDescription ?? null,
      sourceOfFunds: p.sourceOfFunds ?? null,
      beneficiaryRelationship: p.beneficiaryRelationship ?? null,
    },
  };
}
