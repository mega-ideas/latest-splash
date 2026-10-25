/**
 * A self-billed e-invoice for a payment to a foreign supplier (v2 D10, brief
 * 5.4 step 5 and 5.8).
 *
 * Under LHDN's e-Invoice rules a Malaysian business that buys from a supplier
 * outside Malaysia issues the e-invoice itself ("self-billed"), because the
 * foreign supplier is not in the system. This builds that document in the
 * MyInvois UBL 2.1 JSON format; the business submits it through the MyInvois
 * portal (API submission is a later step).
 *
 * Checked on 25 Oct 2026 against the MyInvois SDK
 * (sdk.myinvois.hasil.gov.my):
 *   - e-Invoice type code 11, "Self-billed invoice";
 *   - document version 1.0 (signature validation disabled). Version 1.1 needs
 *     the issuer's digital signature, which Splash does not hold; the SDK says
 *     1.0 will be retired at a date still to be announced, and then this file
 *     must be signed by the submitter;
 *   - the foreign supplier's TIN is the general TIN EI00000000030, its
 *     registration number "NA", its MSIC code "00000" ("NOT APPLICABLE"), its
 *     state code "17" (not applicable);
 *   - classification 034 "Self-billed - Importation of goods", 035
 *     "Self-billed - Importation of services", 036 "Self-billed - Others";
 *   - countries are ISO 3166-1 alpha-3; tax type 06 "Not applicable";
 *   - a document in a currency other than MYR carries the exchange rate to MYR.
 *
 * Nothing here invents a figure. The exchange rate, the buyer's TIN and
 * contact number come from the person creating the file; without them the
 * file is not made, and `selfBilledProblems` says what is missing. Validate in
 * the MyInvois sandbox before relying on a new field.
 */

export const MYINVOIS_PORTAL_URL = 'https://myinvois.hasil.gov.my';
export const FOREIGN_SUPPLIER_TIN = 'EI00000000030';
export const SELF_BILLED_TYPE_CODE = '11';
export const DOCUMENT_VERSION = '1.0';

export const SELF_BILLED_CLASSIFICATIONS = {
  '034': 'Self-billed - Importation of goods',
  '035': 'Self-billed - Importation of services',
  '036': 'Self-billed - Others',
} as const;
export type SelfBilledClassification = keyof typeof SELF_BILLED_CLASSIFICATIONS;

export const MY_STATE_CODES: Record<string, string> = {
  '01': 'Johor', '02': 'Kedah', '03': 'Kelantan', '04': 'Melaka', '05': 'Negeri Sembilan', '06': 'Pahang',
  '07': 'Pulau Pinang', '08': 'Perak', '09': 'Perlis', '10': 'Selangor', '11': 'Terengganu', '12': 'Sabah',
  '13': 'Sarawak', '14': 'Wilayah Persekutuan Kuala Lumpur', '15': 'Wilayah Persekutuan Labuan', '16': 'Wilayah Persekutuan Putrajaya',
};

const ALPHA3: Record<string, string> = {
  MY: 'MYS', PH: 'PHL', ID: 'IDN', SG: 'SGP', TH: 'THA', VN: 'VNM', CN: 'CHN', HK: 'HKG', US: 'USA', IN: 'IND',
  JP: 'JPN', AU: 'AUS', GB: 'GBR', KR: 'KOR', TW: 'TWN', AE: 'ARE', DE: 'DEU', FR: 'FRA', NL: 'NLD',
};

export function alpha3(alpha2: string): string | null {
  return ALPHA3[alpha2.toUpperCase()] ?? null;
}

/** USDC is a US dollar stablecoin with no ISO 4217 code; the e-invoice records it as USD. */
export function documentCurrency(currency: string): string {
  return currency.toUpperCase() === 'USDC' ? 'USD' : currency.toUpperCase();
}

export type SelfBilledInput = {
  /** The business's own number for this e-invoice. */
  eInvoiceNumber: string;
  issuedAt: Date;
  buyer: {
    name: string;
    tin: string;
    registrationNumber: string;
    sstNumber?: string;
    addressLine: string;
    city: string;
    postcode?: string;
    stateCode: string;
    phone: string;
    email?: string;
  };
  supplier: {
    name: string;
    /** ISO 3166-1 alpha-2, as recipients store it. */
    country: string;
    addressLine?: string;
    city?: string;
  };
  /** ISO 4217, or USDC (recorded as USD). */
  currency: string;
  /** MYR per one unit of `currency`, as a decimal string. Required unless the currency is MYR. */
  exchangeRateToMyr?: string;
  /** A decimal string in `currency`. */
  amount: string;
  description: string;
  classification: SelfBilledClassification;
  supplierInvoiceNumber: string;
  /** The Sui transaction that paid it, kept as the payment reference. */
  paymentReference?: string;
};

const TIN = /^(?:C|IG|D|E|F|FA|PT|TA|TC|TN|TR|TP|J|LE)\d{8,12}0?$/i;

export function selfBilledProblems(input: SelfBilledInput): string[] {
  const p: string[] = [];
  if (!input.eInvoiceNumber.trim() || input.eInvoiceNumber.length > 50) p.push('An e-invoice number of up to 50 characters is needed.');
  if (!input.buyer.name.trim()) p.push('Your business’s registered name is missing.');
  if (!TIN.test(input.buyer.tin.trim())) p.push('Your business’s TIN is needed, as LHDN issued it (for example C1234567890).');
  if (!input.buyer.registrationNumber.trim()) p.push('Your business’s registration number (SSM) is missing.');
  if (!input.buyer.addressLine.trim() || !input.buyer.city.trim()) p.push('Your business’s address and city are missing.');
  if (!MY_STATE_CODES[input.buyer.stateCode]) p.push('Choose your business’s state.');
  if (!/^\+?[0-9][0-9 \-]{6,18}$/.test(input.buyer.phone.trim())) p.push('A contact number for your business is needed.');
  if (!input.supplier.name.trim()) p.push('The supplier’s name is missing.');
  if (input.supplier.country.toUpperCase() === 'MY') p.push('The supplier is in Malaysia, so it issues the e-invoice itself. A self-billed one is only for a foreign supplier.');
  else if (!alpha3(input.supplier.country)) p.push('The supplier’s country is not one this file can name.');
  const currency = documentCurrency(input.currency);
  if (!/^[A-Z]{3}$/.test(currency)) p.push('The invoice currency is not an ISO code.');
  if (currency !== 'MYR') {
    if (!input.exchangeRateToMyr || !/^\d{1,6}(\.\d{1,6})?$/.test(input.exchangeRateToMyr) || Number(input.exchangeRateToMyr) <= 0) {
      p.push(`The exchange rate from ${currency} to MYR is needed (for example Bank Negara Malaysia’s rate for the payment date).`);
    }
  }
  if (!/^\d+(\.\d{1,2})?$/.test(input.amount) || Number(input.amount) <= 0) p.push('The amount must be a positive figure with at most two decimals.');
  if (!SELF_BILLED_CLASSIFICATIONS[input.classification]) p.push('Choose whether this paid for goods, services or something else.');
  if (!input.description.trim()) p.push('Describe what was bought.');
  return p;
}

const v = (value: string | number, attrs: Record<string, string> = {}) => [{ _: value, ...attrs }];
const money = (amount: string, currency: string) => [{ _: Number(amount), currencyID: currency }];

function address(a: { line: string; city: string; postcode?: string; state: string; country3: string }) {
  return [{
    CityName: v(a.city),
    ...(a.postcode ? { PostalZone: v(a.postcode) } : {}),
    CountrySubentityCode: v(a.state),
    AddressLine: [{ Line: v(a.line) }],
    Country: [{ IdentificationCode: v(a.country3, { listID: 'ISO3166-1', listAgencyID: '6' }) }],
  }];
}

/**
 * The UBL 2.1 JSON document. Throws when `selfBilledProblems` would not be
 * empty, so a half-made file is never handed out.
 */
export function buildSelfBilledInvoice(input: SelfBilledInput): Record<string, unknown> {
  const problems = selfBilledProblems(input);
  if (problems.length > 0) throw new Error(problems.join(' '));
  const currency = documentCurrency(input.currency);
  const amount = Number(input.amount).toFixed(2);
  const iso = input.issuedAt.toISOString();
  const tax = {
    TaxAmount: money('0', currency),
    TaxSubtotal: [{
      TaxableAmount: money(amount, currency),
      TaxAmount: money('0', currency),
      TaxCategory: [{ ID: v('06'), TaxScheme: [{ ID: v('OTH', { schemeID: 'UN/ECE 5153', schemeAgencyID: '6' }) }] }],
    }],
  };
  const invoice: Record<string, unknown> = {
    ID: v(input.eInvoiceNumber),
    IssueDate: v(iso.slice(0, 10)),
    IssueTime: v(`${iso.slice(11, 19)}Z`),
    InvoiceTypeCode: v(SELF_BILLED_TYPE_CODE, { listVersionID: DOCUMENT_VERSION }),
    DocumentCurrencyCode: v(currency),
    TaxCurrencyCode: v('MYR'),
    ...(currency !== 'MYR' ? {
      TaxExchangeRate: [{
        SourceCurrencyCode: v(currency),
        TargetCurrencyCode: v('MYR'),
        CalculationRate: v(Number(input.exchangeRateToMyr)),
      }],
    } : {}),
    AccountingSupplierParty: [{
      Party: [{
        IndustryClassificationCode: v('00000', { name: 'NOT APPLICABLE' }),
        PartyIdentification: [
          { ID: v(FOREIGN_SUPPLIER_TIN, { schemeID: 'TIN' }) },
          { ID: v('NA', { schemeID: 'BRN' }) },
          { ID: v('NA', { schemeID: 'SST' }) },
          { ID: v('NA', { schemeID: 'TTX' }) },
        ],
        PostalAddress: address({
          line: input.supplier.addressLine?.trim() || 'NA',
          city: input.supplier.city?.trim() || 'NA',
          state: '17',
          country3: alpha3(input.supplier.country) as string,
        }),
        PartyLegalEntity: [{ RegistrationName: v(input.supplier.name.trim()) }],
        Contact: [{ Telephone: v('NA') }],
      }],
    }],
    AccountingCustomerParty: [{
      Party: [{
        PartyIdentification: [
          { ID: v(input.buyer.tin.trim().toUpperCase(), { schemeID: 'TIN' }) },
          { ID: v(input.buyer.registrationNumber.trim(), { schemeID: 'BRN' }) },
          { ID: v(input.buyer.sstNumber?.trim() || 'NA', { schemeID: 'SST' }) },
        ],
        PostalAddress: address({
          line: input.buyer.addressLine.trim(),
          city: input.buyer.city.trim(),
          postcode: input.buyer.postcode?.trim(),
          state: input.buyer.stateCode,
          country3: 'MYS',
        }),
        PartyLegalEntity: [{ RegistrationName: v(input.buyer.name.trim()) }],
        Contact: [{ Telephone: v(input.buyer.phone.trim()), ...(input.buyer.email ? { ElectronicMail: v(input.buyer.email.trim()) } : {}) }],
      }],
    }],
    PaymentMeans: [{
      PaymentMeansCode: v('08'),
      ...(input.paymentReference ? { PayeeFinancialAccount: [{ ID: v(input.paymentReference) }] } : {}),
    }],
    TaxTotal: [tax],
    LegalMonetaryTotal: [{
      LineExtensionAmount: money(amount, currency),
      TaxExclusiveAmount: money(amount, currency),
      TaxInclusiveAmount: money(amount, currency),
      PayableAmount: money(amount, currency),
    }],
    InvoiceLine: [{
      ID: v('1'),
      InvoicedQuantity: v(1, { unitCode: 'C62' }),
      LineExtensionAmount: money(amount, currency),
      TaxTotal: [tax],
      Item: [{
        CommodityClassification: [{ ItemClassificationCode: v(input.classification, { listID: 'CLASS' }) }],
        Description: v(`${input.description.trim()} (supplier invoice ${input.supplierInvoiceNumber})`),
        OriginCountry: [{ IdentificationCode: v(alpha3(input.supplier.country) as string) }],
      }],
      Price: [{ PriceAmount: money(amount, currency) }],
      ItemPriceExtension: [{ Amount: money(amount, currency) }],
    }],
  };
  return {
    _D: 'urn:oasis:names:specification:ubl:schema:xsd:Invoice-2',
    _A: 'urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2',
    _B: 'urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2',
    Invoice: [invoice],
  };
}
