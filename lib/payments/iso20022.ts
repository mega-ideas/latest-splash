/**
 * ISO 20022-shaped payment data (v2 §4.5, D12): the ONE mapping from what the
 * recipient form collects to pacs.008-style fields. Every payout adapter
 * builds its partner payload from `pacs008ForInstruction` and checks it with
 * `assertPacs008Matches`, and the per-payment controls-evidence export takes
 * `pacs008Evidence` (masked) from the same message. Nothing here does I/O.
 *
 * What the form collects, and where it goes:
 *
 *   form field                 pacs.008 element (CdtTrfTxInf)
 *   ─────────────────────────  ─────────────────────────────────────────────
 *   account holder name        Cdtr/Nm and CdtrAcct/Nm
 *   structured address         Cdtr/PstlAdr (StrtNm, BldgNb, BldgNm, Flr,
 *                              PstBx, Room, PstCd, TwnNm, TwnLctnNm, DstrctNm,
 *                              CtrySubDvsn, Ctry). Structured only: there is
 *                              no AdrLine, because CBPR+ stops taking
 *                              unstructured addresses in November 2026, and a
 *                              town and a country are always required.
 *   registration number        Cdtr/Id/OrgId/Othr/Id, SchmeNm/Cd CINC (a
 *                              company registration) or TXID (a tax id),
 *                              Issr the issuing country
 *   bank code, account number  CdtrAgt/FinInstnId (BICFI when the code is a
 *                              BIC, ClrSysMmbId/MmbId otherwise) and
 *                              CdtrAcct/Id/Othr/Id
 *   purpose code               Purp/Cd (ExternalPurpose1Code)
 *   relationship               RgltryRptg/Dtls (Tp RELATIONSHIP)
 *   source of funds            RgltryRptg/Dtls (Tp SOURCE_OF_FUNDS)
 *   invoice / reference        RmtInf/Ustrd
 *
 * And from the payment itself: PmtId (EndToEndId and UETR, both derived from
 * the on-chain intent id, so the partner can match the deposit), InstdAmt
 * (the USDC principal, as USD), IntrBkSttlmAmt (what the bank account
 * receives, in the local currency), XchgRate, ChrgBr SHAR (Splash's fee is
 * on top and the partner's fee comes out of what it pays), Dbtr (the paying
 * business from its KYB profile) and DbtrAcct (its Sui wallet). The
 * settlement asset, the network, the deposit address and the beneficiary
 * commitment ride in SplmtryData.
 *
 * "pacs.008-style": a JSON object shaped like the message, with its element
 * names, not a schema-valid XML document. A partner's own API format is
 * built from it in the adapter.
 */

import { createHash } from 'node:crypto';

// ─── The vocabularies ───────────────────────────────────────────────────────

/** ExternalPurpose1Code values a business payout may carry. */
export const PURPOSE_CODES = {
  SUPP: 'Supplier payment',
  GDDS: 'Purchase or sale of goods',
  SCVE: 'Purchase or sale of services',
  TRAD: 'Trade services',
  COMC: 'Commercial payment',
  RENT: 'Rent',
  LICF: 'Licence fee',
  INTC: 'Intra-company payment',
  CASH: 'Cash management transfer',
} as const;
export type PurposeCode = keyof typeof PURPOSE_CODES;

/** The payer's relationship to the beneficiary. */
export const RELATIONSHIPS = {
  self: 'The business itself',
  subsidiary: 'Subsidiary',
  parent_company: 'Parent company',
  affiliate: 'Affiliate',
  supplier: 'Supplier',
  customer: 'Customer',
  contractor: 'Contractor',
  service_provider: 'Service provider',
  other: 'Other',
} as const;
export type Relationship = keyof typeof RELATIONSHIPS;

/** Where the money paid comes from. */
export const SOURCES_OF_FUNDS = {
  business_revenue: 'Business revenue',
  retained_earnings: 'Retained earnings',
  capital_contribution: 'Capital contribution',
  loan_proceeds: 'Loan proceeds',
  investment_proceeds: 'Investment proceeds',
  sale_of_assets: 'Sale of assets',
  other: 'Other',
} as const;
export type SourceOfFunds = keyof typeof SOURCES_OF_FUNDS;

export const REGISTRATION_SCHEMES = ['CINC', 'TXID'] as const;
export type RegistrationScheme = (typeof REGISTRATION_SCHEMES)[number];

export const isPurposeCode = (v: unknown): v is PurposeCode => typeof v === 'string' && Object.hasOwn(PURPOSE_CODES, v);
export const isRelationship = (v: unknown): v is Relationship => typeof v === 'string' && Object.hasOwn(RELATIONSHIPS, v);
export const isSourceOfFunds = (v: unknown): v is SourceOfFunds => typeof v === 'string' && Object.hasOwn(SOURCES_OF_FUNDS, v);

export class Iso20022Error extends Error {
  readonly code: string;
  /** The form field at fault, for the form to point at. */
  readonly field: string;
  constructor(message: string, field: string, code = 'bad_iso20022') {
    super(message);
    this.name = 'Iso20022Error';
    this.code = code;
    this.field = field;
  }
}

// ─── The form, normalized ───────────────────────────────────────────────────

/** A structured postal address (PostalAddress24). Town and country are required. */
export type StructuredAddress = {
  streetName?: string;
  buildingNumber?: string;
  buildingName?: string;
  floor?: string;
  postBox?: string;
  room?: string;
  postCode?: string;
  townName: string;
  townLocationName?: string;
  districtName?: string;
  countrySubDivision?: string;
  /** ISO 3166-1 alpha-2. */
  country: string;
};

/** A party as the form collects it: the legal name, the address and, for a company, its registration. */
export type Iso20022Party = {
  name: string;
  address?: StructuredAddress;
  registrationNumber?: string;
  registrationScheme?: RegistrationScheme;
  /** The country that issued the registration (defaults to the address's country). */
  registrationIssuer?: string;
};

/**
 * The CBPR+ character set: Latin letters, digits, space and . , ' + - / ? : ( ),
 * plus the members of the CBPR+ extended set a business name or address
 * really uses: & # @ ! % * = _ ; (common in company names, and in MY and SG
 * unit numbers such as "#12-03"). An adapter that writes XML escapes & with
 * escapeXmlText; the JSON message carries it as is.
 *
 * Anything else (an accented letter, another script, an emoji, a control
 * character) is refused where the name is one a bank checks: a supplier's
 * holder name, refused when the supplier is added, before any name check.
 * Where the text is the business's own (the debtor, and the creditor of a
 * withdrawal) it is transliterated instead (lenient mode), and the message
 * lists the fields it changed (SplmtryData.transliterated): no payout is
 * blocked on how the business's own name is spelled.
 */
const LATIN = /^[A-Za-z0-9 .,'+\-/?:()&#@!%*=_;]+$/;
const NOT_LATIN = /[^A-Za-z0-9 .,'+\-/?:()&#@!%*=_;]/g;

/** Letters (and typographic marks) NFKD does not turn into a base letter and a mark. */
const SPECIAL_LETTERS: Record<string, string> = {
  'ß': 'ss', 'Æ': 'AE', 'æ': 'ae', 'Ø': 'O', 'ø': 'o', 'Œ': 'OE', 'œ': 'oe', 'Đ': 'D', 'đ': 'd', 'Ł': 'L', 'ł': 'l', 'Þ': 'TH', 'þ': 'th', 'ı': 'i',
  '‘': "'", '’': "'", '“': "'", '”': "'", '–': '-', '—': '-',
};
const SPECIAL_RE = new RegExp(`[${Object.keys(SPECIAL_LETTERS).join('')}]`, 'g');

/**
 * Latin text with its accents removed ("Cafe" for "Café"), and anything still
 * outside the CBPR+ set replaced by a space. Another script comes out empty.
 */
export function transliterate(value: string): string {
  return value
    .replace(SPECIAL_RE, (c) => SPECIAL_LETTERS[c] ?? ' ')
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .replace(NOT_LATIN, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Text for an XML element, with & < > escaped. The JSON message is not escaped; an adapter that writes XML uses this. */
export function escapeXmlText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Lenient mode: transliterate instead of refusing, and record which fields were changed or left out. */
type TextMode = { changed: string[] };

const ADDRESS_LIMITS: Record<keyof StructuredAddress, number> = {
  streetName: 70,
  buildingNumber: 16,
  buildingName: 35,
  floor: 70,
  postBox: 16,
  room: 70,
  postCode: 16,
  townName: 35,
  townLocationName: 35,
  districtName: 35,
  countrySubDivision: 35,
  country: 2,
};

function text(value: unknown, field: string, max: number, required: boolean, mode?: TextMode): string | undefined {
  let v = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : value === undefined || value === null ? '' : null;
  if (v === null) throw new Iso20022Error(`${field} must be text.`, field);
  if (v && !LATIN.test(v)) {
    if (!mode) throw new Iso20022Error(`${field} may use Latin letters without accents, digits, spaces and . , ' + - / ? : ( ) & # @ ! % * = _ ; only.`, field);
    v = transliterate(v);
    mode.changed.push(field);
  }
  if (!v) {
    if (required) throw new Iso20022Error(`${field} is required.`, field, 'iso20022_missing');
    return undefined;
  }
  if (v.length > max) {
    if (!mode) throw new Iso20022Error(`${field} is longer than ${max} characters.`, field);
    v = v.slice(0, max).trim();
    mode.changed.push(field);
  }
  return v;
}

/** Whether a holder name is in the character set a bank-checked name must use (checked when an account is added). */
export function isCbprText(value: string): boolean {
  return LATIN.test(value.replace(/\s+/g, ' ').trim());
}

function country(value: unknown, field: string): string {
  const v = typeof value === 'string' ? value.trim().toUpperCase() : '';
  if (!/^[A-Z]{2}$/.test(v)) throw new Iso20022Error(`${field} must be a two-letter country code.`, field, v ? 'bad_iso20022' : 'iso20022_missing');
  return v;
}

export function normalizeAddress(input: unknown, field = 'address', mode?: TextMode): StructuredAddress {
  if (!input || typeof input !== 'object') throw new Iso20022Error('A structured address (at least a town and a country) is required.', field, 'iso20022_missing');
  const a = input as Record<string, unknown>;
  if ('addressLine' in a || 'adrLine' in a || 'AdrLine' in a) {
    throw new Iso20022Error('Give the address in its parts (street, building, post code, town, country), not as free lines.', field);
  }
  const out: StructuredAddress = { townName: text(a.townName, `${field}.townName`, ADDRESS_LIMITS.townName, true, mode) as string, country: country(a.country, `${field}.country`) };
  for (const key of Object.keys(ADDRESS_LIMITS) as Array<keyof StructuredAddress>) {
    if (key === 'townName' || key === 'country') continue;
    const v = text(a[key], `${field}.${key}`, ADDRESS_LIMITS[key], false, mode);
    if (v) out[key] = v;
  }
  return out;
}

/**
 * A party from the form. With `lenient` (the business's own text: the debtor,
 * a withdrawal's creditor) nothing in it refuses a payout that can still be
 * described: the name and address are transliterated, an optional address or
 * registration that still cannot be read is left out, and every field changed
 * or left out is pushed onto `lenient.changed`.
 */
export function normalizeParty(input: unknown, opts: { field?: string; requireAddress?: boolean; requireRegistration?: boolean; lenient?: TextMode } = {}): Iso20022Party {
  const field = opts.field ?? 'party';
  const mode = opts.lenient;
  if (!input || typeof input !== 'object') throw new Iso20022Error(`${field} is required.`, field, 'iso20022_missing');
  const p = input as Record<string, unknown>;
  const name = text(p.name, `${field}.name`, 140, true, mode) as string;
  if (name.length < 2) throw new Iso20022Error(`${field}.name is too short.`, `${field}.name`);
  const out: Iso20022Party = { name };
  if (p.address !== undefined && p.address !== null) {
    try {
      out.address = normalizeAddress(p.address, `${field}.address`, mode);
    } catch (error) {
      if (!mode || opts.requireAddress || !(error instanceof Iso20022Error)) throw error;
      mode.changed.push(`${field}.address`);
    }
  } else if (opts.requireAddress) throw new Iso20022Error(`${field} needs a structured address (at least a town and a country).`, `${field}.address`, 'iso20022_missing');
  const reg = typeof p.registrationNumber === 'string' ? p.registrationNumber.replace(/\s+/g, '').toUpperCase() : '';
  if (reg && mode && !opts.requireRegistration && !/^[A-Z0-9\-/.]{2,35}$/.test(reg)) {
    mode.changed.push(`${field}.registrationNumber`);
    return out;
  }
  if (reg) {
    if (!/^[A-Z0-9\-/.]{2,35}$/.test(reg)) throw new Iso20022Error(`${field}.registrationNumber is not a registration number.`, `${field}.registrationNumber`);
    const scheme = p.registrationScheme === undefined || p.registrationScheme === null || p.registrationScheme === '' ? 'CINC' : p.registrationScheme;
    if (!(REGISTRATION_SCHEMES as readonly unknown[]).includes(scheme)) throw new Iso20022Error(`${field}.registrationScheme must be CINC or TXID.`, `${field}.registrationScheme`);
    out.registrationNumber = reg;
    out.registrationScheme = scheme as RegistrationScheme;
    const issuer = p.registrationIssuer ?? out.address?.country;
    if (issuer) out.registrationIssuer = country(issuer, `${field}.registrationIssuer`);
  } else if (opts.requireRegistration) {
    throw new Iso20022Error(`${field} needs its registration number.`, `${field}.registrationNumber`, 'iso20022_missing');
  }
  return out;
}

// ─── The message ────────────────────────────────────────────────────────────

type PstlAdr = {
  StrtNm?: string;
  BldgNb?: string;
  BldgNm?: string;
  Flr?: string;
  PstBx?: string;
  Room?: string;
  PstCd?: string;
  TwnNm: string;
  TwnLctnNm?: string;
  DstrctNm?: string;
  CtrySubDvsn?: string;
  Ctry: string;
};

type PartyId = { OrgId: { Othr: Array<{ Id: string; SchmeNm: { Cd: RegistrationScheme }; Issr?: string }> } };
type Party = { Nm: string; PstlAdr?: PstlAdr; Id?: PartyId };
type Amount = { Amt: string; Ccy: string };

/** One pacs.008 credit transfer transaction, as JSON. */
export type Pacs008 = {
  MsgDefIdr: 'pacs.008.001.08';
  CdtTrfTxInf: {
    PmtId: { InstrId: string; EndToEndId: string; UETR: string };
    InstdAmt: Amount;
    IntrBkSttlmAmt: Amount;
    XchgRate: string;
    ChrgBr: 'SHAR';
    ChrgsInf: Array<{ Amt: Amount; Tp: string }>;
    Dbtr: Party;
    DbtrAcct: { Id: { Othr: { Id: string; SchmeNm: { Prtry: 'SUI_ADDRESS' } } } };
    CdtrAgt: { FinInstnId: { BICFI: string } | { ClrSysMmbId: { MmbId: string }; PstlAdr: { Ctry: string } } };
    Cdtr: Party;
    CdtrAcct: { Id: { Othr: { Id: string } }; Nm: string };
    Purp: { Cd: PurposeCode };
    RgltryRptg: Array<{ Dtls: Array<{ Tp: 'RELATIONSHIP' | 'SOURCE_OF_FUNDS'; Cd: string; Inf: string[] }> }>;
    RmtInf?: { Ustrd: string[] };
    SplmtryData: {
      intentId: string;
      settlementAsset: { symbol: 'USDC'; decimals: 6; network: 'sui' };
      sourceWallet: string;
      depositAddress: string;
      beneficiaryRef: string;
      /** The fields of the business's own text that were transliterated or left out (lenient mode); absent when none were. */
      transliterated?: string[];
    };
  };
};

/** The payment-level facts the form adds to a beneficiary for one payout. */
export type PaymentDeclaration = {
  purposeCode: PurposeCode;
  relationship: Relationship;
  /** Required for a payment to a third party; a business moving its own money may leave it out. */
  sourceOfFunds?: SourceOfFunds;
  /** An invoice number or reference for the beneficiary, up to 140 characters. */
  remittanceInfo?: string;
};

export function normalizeDeclaration(input: unknown, opts: { thirdParty: boolean }): PaymentDeclaration {
  const d = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  if (!isPurposeCode(d.purposeCode)) throw new Iso20022Error(`purposeCode must be one of ${Object.keys(PURPOSE_CODES).join(', ')}.`, 'purposeCode', d.purposeCode ? 'bad_iso20022' : 'iso20022_missing');
  if (!isRelationship(d.relationship)) throw new Iso20022Error(`relationship must be one of ${Object.keys(RELATIONSHIPS).join(', ')}.`, 'relationship', d.relationship ? 'bad_iso20022' : 'iso20022_missing');
  if (opts.thirdParty && d.relationship === 'self') throw new Iso20022Error("A payment to the business's own account is a withdrawal, not a payout.", 'relationship');
  if (!opts.thirdParty && d.relationship !== 'self') throw new Iso20022Error("A withdrawal goes to the business's own account.", 'relationship');
  const out: PaymentDeclaration = { purposeCode: d.purposeCode, relationship: d.relationship };
  if (d.sourceOfFunds !== undefined && d.sourceOfFunds !== null && d.sourceOfFunds !== '') {
    if (!isSourceOfFunds(d.sourceOfFunds)) throw new Iso20022Error(`sourceOfFunds must be one of ${Object.keys(SOURCES_OF_FUNDS).join(', ')}.`, 'sourceOfFunds');
    out.sourceOfFunds = d.sourceOfFunds;
  } else if (opts.thirdParty) {
    throw new Iso20022Error('sourceOfFunds is required for a payment to another business.', 'sourceOfFunds', 'iso20022_missing');
  }
  const r = text(d.remittanceInfo, 'remittanceInfo', 140, false);
  if (r) out.remittanceInfo = r;
  return out;
}

/** EndToEndId (max 35): `SPL` and the first 32 hex digits of the intent id. */
export function endToEndIdFor(intentId: string): string {
  const hex = intentId.toLowerCase().replace(/^0x/, '');
  if (!/^[0-9a-f]{64}$/.test(hex)) throw new Iso20022Error('An intent id is 32 bytes of hex.', 'intentId');
  return `SPL${hex.slice(0, 32)}`;
}

/** UETR: a version-4-shaped UUID derived from the intent id, the same on every retry. */
export function uetrFor(intentId: string): string {
  const h = createHash('sha256').update(`splash:uetr:v1:${intentId.toLowerCase()}`).digest();
  h[6] = (h[6] & 0x0f) | 0x40;
  h[8] = (h[8] & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
}

/** Minor units at `decimals` as a decimal string, exactly. */
export function decimalOf(minor: bigint, decimals: number): string {
  if (minor < 0n) throw new Iso20022Error('An amount is never negative.', 'amount');
  if (decimals === 0) return minor.toString();
  const s = minor.toString().padStart(decimals + 1, '0');
  return `${s.slice(0, -decimals)}.${s.slice(-decimals)}`;
}

/** Decimal places each payout currency is paid in: IDR in whole rupiah. */
export const LOCAL_DECIMALS: Record<string, number> = { PHP: 2, IDR: 0, MYR: 2, USDC: 6 };

export function localDecimals(currency: string): number {
  const d = LOCAL_DECIMALS[currency.toUpperCase()];
  if (d === undefined) throw new Iso20022Error(`No payout is made in ${currency}.`, 'currency');
  return d;
}

function pstlAdr(a: StructuredAddress): PstlAdr {
  const out: PstlAdr = { TwnNm: a.townName, Ctry: a.country };
  const map: Array<[keyof StructuredAddress, keyof PstlAdr]> = [
    ['streetName', 'StrtNm'],
    ['buildingNumber', 'BldgNb'],
    ['buildingName', 'BldgNm'],
    ['floor', 'Flr'],
    ['postBox', 'PstBx'],
    ['room', 'Room'],
    ['postCode', 'PstCd'],
    ['townLocationName', 'TwnLctnNm'],
    ['districtName', 'DstrctNm'],
    ['countrySubDivision', 'CtrySubDvsn'],
  ];
  for (const [from, to] of map) if (a[from]) (out as Record<string, string>)[to] = a[from] as string;
  return out;
}

function party(p: Iso20022Party): Party {
  const out: Party = { Nm: p.name };
  if (p.address) out.PstlAdr = pstlAdr(p.address);
  if (p.registrationNumber) {
    out.Id = { OrgId: { Othr: [{ Id: p.registrationNumber, SchmeNm: { Cd: p.registrationScheme ?? 'CINC' }, ...(p.registrationIssuer ? { Issr: p.registrationIssuer } : {}) }] } };
  }
  return out;
}

const BIC = /^[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}([A-Z0-9]{3})?$/;

/** What `pacs008ForInstruction` needs: the instruction's own fields plus the parties and the declaration. */
export type Pacs008Input = {
  intentId: string;
  /** The partner's quote reference: InstrId. */
  quoteRef: string;
  expectedUsdcMinor: bigint;
  currency: string;
  receiveMinor: bigint;
  rateMicro: bigint;
  beneficiary: { country: string; bankCode: string; accountNumber: string; holderName: string };
  beneficiaryRef: string;
  sourceWallet: string;
  depositAddress: string;
  debtor: Iso20022Party;
  creditor: Iso20022Party;
  declaration: PaymentDeclaration;
  /** The partner's fee lines from its quote, in the local currency's minor units. */
  charges?: Array<{ label: string; currency: string; amountMinor: bigint }>;
  /** Fields already transliterated upstream (debtorFromProfile), listed in the message with any changed here. */
  transliterated?: string[];
};

/**
 * Build the pacs.008-style message for one bank payout. The creditor's name
 * must be the account holder's, and its address (when given) must be in the
 * bank's country, so the message cannot describe a different payee from the
 * account the intent commits to.
 */
export function pacs008ForInstruction(input: Pacs008Input): Pacs008 {
  // A payment to another business needs the creditor's structured address; a
  // business paying its own account is the creditor, and its address is the
  // KYB file's, given when the profile has it.
  const thirdParty = input.declaration?.relationship !== 'self';
  // The debtor is always the paying business's own KYB text, and so is the
  // creditor of a withdrawal: transliterated, never a refusal. A supplier's
  // name is the one its bank checks, validated when the supplier was added.
  const changed: string[] = [...(input.transliterated ?? [])];
  const own: TextMode | undefined = thirdParty ? undefined : { changed };
  const debtor = normalizeParty(input.debtor, { field: 'debtor', lenient: { changed } });
  const creditor = normalizeParty(input.creditor, { field: 'creditor', requireAddress: thirdParty, lenient: own });
  const declaration = normalizeDeclaration(input.declaration, { thirdParty });
  const holder = text(input.beneficiary.holderName, 'beneficiary.holderName', 140, true, own) as string;
  if (fold(holder) !== fold(creditor.name)) throw new Iso20022Error('The creditor is not the account holder.', 'creditor.name', 'iso20022_mismatch');
  // The bank's country decides the route; the creditor's address may be elsewhere.
  const bankCountry = country(input.beneficiary.country, 'beneficiary.country');
  const ccy = input.currency.toUpperCase();
  const dec = localDecimals(ccy);
  const bankCode = input.beneficiary.bankCode.replace(/\s+/g, '').toUpperCase();
  const accountNumber = input.beneficiary.accountNumber.replace(/[\s-]+/g, '').toUpperCase();
  if (!/^[A-Z0-9]{4,34}$/.test(accountNumber)) throw new Iso20022Error('The account number is not valid.', 'beneficiary.accountNumber');
  if (!/^[A-Z0-9]{2,20}$/.test(bankCode)) throw new Iso20022Error('The bank code is not valid.', 'beneficiary.bankCode');
  if (input.expectedUsdcMinor <= 0n) throw new Iso20022Error('A payout carries an amount.', 'amount');
  if (input.rateMicro <= 0n) throw new Iso20022Error('A payout carries its rate.', 'rate');
  const ustrd = declaration.remittanceInfo ? [declaration.remittanceInfo] : [];
  const dtls: Pacs008['CdtTrfTxInf']['RgltryRptg'][number]['Dtls'] = [
    { Tp: 'RELATIONSHIP', Cd: declaration.relationship, Inf: [RELATIONSHIPS[declaration.relationship]] },
  ];
  if (declaration.sourceOfFunds) dtls.push({ Tp: 'SOURCE_OF_FUNDS', Cd: declaration.sourceOfFunds, Inf: [SOURCES_OF_FUNDS[declaration.sourceOfFunds]] });
  return {
    MsgDefIdr: 'pacs.008.001.08',
    CdtTrfTxInf: {
      PmtId: { InstrId: input.quoteRef.slice(0, 35), EndToEndId: endToEndIdFor(input.intentId), UETR: uetrFor(input.intentId) },
      InstdAmt: { Amt: decimalOf(input.expectedUsdcMinor, 6), Ccy: 'USD' },
      IntrBkSttlmAmt: { Amt: decimalOf(input.receiveMinor, dec), Ccy: ccy },
      XchgRate: decimalOf(input.rateMicro, 6),
      ChrgBr: 'SHAR',
      ChrgsInf: chargesOf(input.charges),
      Dbtr: party(debtor),
      DbtrAcct: { Id: { Othr: { Id: input.sourceWallet, SchmeNm: { Prtry: 'SUI_ADDRESS' } } } },
      CdtrAgt: { FinInstnId: BIC.test(bankCode) ? { BICFI: bankCode } : { ClrSysMmbId: { MmbId: bankCode }, PstlAdr: { Ctry: bankCountry } } },
      Cdtr: party(creditor),
      CdtrAcct: { Id: { Othr: { Id: accountNumber } }, Nm: holder },
      Purp: { Cd: declaration.purposeCode },
      RgltryRptg: [{ Dtls: dtls }],
      ...(ustrd.length ? { RmtInf: { Ustrd: ustrd } } : {}),
      SplmtryData: {
        intentId: input.intentId.toLowerCase(),
        settlementAsset: { symbol: 'USDC', decimals: 6, network: 'sui' },
        sourceWallet: input.sourceWallet,
        depositAddress: input.depositAddress,
        beneficiaryRef: input.beneficiaryRef.toLowerCase().replace(/^0x/, ''),
        ...(changed.length ? { transliterated: [...new Set(changed)] } : {}),
      },
    },
  };
}

function chargesOf(charges: Pacs008Input['charges']): Pacs008['CdtTrfTxInf']['ChrgsInf'] {
  return (charges ?? []).map((c) => ({ Amt: { Amt: decimalOf(c.amountMinor, localDecimals(c.currency)), Ccy: c.currency.toUpperCase() }, Tp: c.label.slice(0, 35) }));
}

/** A name as compared: transliterated, upper case, letters and digits only. */
function fold(name: string): string {
  return transliterate(name).toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();
}

/**
 * What every adapter checks before it sends a partner the message: it is the
 * instruction's own payee, account, amount and intent. A message built for
 * another payout (or edited after it was built) is refused, not sent.
 */
export function assertPacs008Matches(
  msg: Pacs008 | null | undefined,
  instruction: {
    intentId: string;
    expectedUsdcMinor: bigint;
    currency: string;
    receiveMinor: bigint;
    minReceiveMinor: bigint;
    rateMicro: bigint;
    beneficiary: { bankCode: string; accountNumber: string; holderName: string };
    beneficiaryRef: string;
    depositAddress: string;
    sourceWallet: string;
    /** The paying business (the travel rule's originator half). */
    debtor: Iso20022Party;
    /** The partner's fee lines from its quote. */
    charges: Array<{ label: string; currency: string; amountMinor: bigint }>;
  },
): Pacs008 {
  const bad = (why: string): never => {
    throw new Iso20022Error(`The ISO 20022 payment data does not match this payout: ${why}. Nothing was sent.`, 'iso20022', 'iso20022_mismatch');
  };
  if (!msg || msg.MsgDefIdr !== 'pacs.008.001.08') return bad('it is missing');
  const t = msg.CdtTrfTxInf;
  if (t.PmtId.EndToEndId !== endToEndIdFor(instruction.intentId) || t.PmtId.UETR !== uetrFor(instruction.intentId)) bad('another intent');
  if (t.SplmtryData.intentId !== instruction.intentId.toLowerCase()) bad('another intent');
  if (t.InstdAmt.Amt !== decimalOf(instruction.expectedUsdcMinor, 6)) bad('another amount');
  if (t.IntrBkSttlmAmt.Ccy !== instruction.currency.toUpperCase()) bad('another currency');
  if (t.IntrBkSttlmAmt.Amt !== decimalOf(instruction.receiveMinor, localDecimals(instruction.currency))) bad('another settlement amount');
  if (instruction.receiveMinor < instruction.minReceiveMinor) bad('it pays less than the owners accepted');
  if (t.XchgRate !== decimalOf(instruction.rateMicro, 6)) bad('another rate');
  if (JSON.stringify(t.ChrgsInf) !== JSON.stringify(chargesOf(instruction.charges))) bad('other charges');
  if (fold(t.Dbtr.Nm) !== fold(instruction.debtor.name)) bad('another debtor');
  const wantReg = instruction.debtor.registrationNumber ? instruction.debtor.registrationNumber.replace(/\s+/g, '').toUpperCase() : null;
  if (wantReg !== null && t.Dbtr.Id?.OrgId.Othr[0]?.Id !== wantReg) bad("another debtor's registration");
  if (t.CdtrAcct.Id.Othr.Id !== instruction.beneficiary.accountNumber.replace(/[\s-]+/g, '').toUpperCase()) bad('another account');
  if (fold(t.CdtrAcct.Nm) !== fold(instruction.beneficiary.holderName) || fold(t.Cdtr.Nm) !== fold(instruction.beneficiary.holderName)) bad('another account holder');
  const agt = t.CdtrAgt.FinInstnId as { BICFI?: string; ClrSysMmbId?: { MmbId: string } };
  if ((agt.BICFI ?? agt.ClrSysMmbId?.MmbId) !== instruction.beneficiary.bankCode.replace(/\s+/g, '').toUpperCase()) bad('another bank');
  if (t.SplmtryData.beneficiaryRef !== instruction.beneficiaryRef.toLowerCase().replace(/^0x/, '')) bad('another beneficiary commitment');
  if (t.SplmtryData.depositAddress !== instruction.depositAddress || t.SplmtryData.sourceWallet !== instruction.sourceWallet) bad('another deposit or wallet');
  const relationship = t.RgltryRptg?.[0]?.Dtls.find((d) => d.Tp === 'RELATIONSHIP')?.Cd;
  if (!isRelationship(relationship)) bad('no relationship');
  if (relationship !== 'self' && (!t.Cdtr.PstlAdr?.TwnNm || !t.Cdtr.PstlAdr?.Ctry)) bad("the creditor's structured address is missing");
  if (!isPurposeCode(t.Purp?.Cd)) bad('no purpose code');
  return msg;
}

// ─── The evidence export ────────────────────────────────────────────────────

/** The ISO 20022 section of the per-payment controls-evidence export: the same message, masked. */
export type Pacs008Evidence = {
  messageDefinition: 'pacs.008.001.08';
  endToEndId: string;
  uetr: string;
  instructedAmount: Amount;
  settlementAmount: Amount;
  exchangeRate: string;
  chargeBearer: 'SHAR';
  charges: Array<{ Amt: Amount; Tp: string }>;
  debtor: { name: string; registration: string | null; country: string | null; wallet: string };
  creditor: { name: string; registration: string | null; town: string; country: string };
  creditorAgent: string;
  /** The account number's last four only. */
  creditorAccountLast4: string;
  purposeCode: PurposeCode;
  relationship: string;
  sourceOfFunds: string | null;
  remittanceInfo: string | null;
  depositAddress: string;
  beneficiaryRef: string;
};

/**
 * What the evidence export shows of a payout's message: who paid whom, why,
 * and from what. A mask suffices for the account number and for both
 * registration numbers, so only their last four characters are kept, and of
 * the creditor's address only the town and country (the partner holds the
 * full message, and the supplier's sealed party the rest).
 */
export function pacs008Evidence(msg: Pacs008): Pacs008Evidence {
  const t = msg.CdtTrfTxInf;
  // A registration number is masked like the account: its scheme and last four.
  const reg = (p: Party) => (p.Id ? `${p.Id.OrgId.Othr[0].SchmeNm.Cd} ****${p.Id.OrgId.Othr[0].Id.slice(-4)}` : null);
  const agt = t.CdtrAgt.FinInstnId as { BICFI?: string; ClrSysMmbId?: { MmbId: string } };
  const rel = t.RgltryRptg[0]?.Dtls.find((d) => d.Tp === 'RELATIONSHIP');
  const sof = t.RgltryRptg[0]?.Dtls.find((d) => d.Tp === 'SOURCE_OF_FUNDS');
  return {
    messageDefinition: msg.MsgDefIdr,
    endToEndId: t.PmtId.EndToEndId,
    uetr: t.PmtId.UETR,
    instructedAmount: t.InstdAmt,
    settlementAmount: t.IntrBkSttlmAmt,
    exchangeRate: t.XchgRate,
    chargeBearer: t.ChrgBr,
    charges: t.ChrgsInf,
    debtor: { name: t.Dbtr.Nm, registration: reg(t.Dbtr), country: t.Dbtr.PstlAdr?.Ctry ?? null, wallet: t.DbtrAcct.Id.Othr.Id },
    creditor: { name: t.Cdtr.Nm, registration: reg(t.Cdtr), town: t.Cdtr.PstlAdr?.TwnNm ?? '', country: t.Cdtr.PstlAdr?.Ctry ?? '' },
    creditorAgent: agt.BICFI ?? agt.ClrSysMmbId?.MmbId ?? '',
    creditorAccountLast4: t.CdtrAcct.Id.Othr.Id.slice(-4),
    purposeCode: t.Purp.Cd,
    relationship: rel?.Cd ?? '',
    sourceOfFunds: sof?.Cd ?? null,
    remittanceInfo: t.RmtInf?.Ustrd[0] ?? null,
    depositAddress: t.SplmtryData.depositAddress,
    beneficiaryRef: t.SplmtryData.beneficiaryRef,
  };
}

/**
 * The paying business as a party, from its KYB profile (lib/server/originator.ts
 * reads the same columns, and the owner's profile save writes them,
 * lib/server/onboarding.ts). Line 1 is the street, line 2 the building. The
 * text is the business's own, so it is transliterated rather than refused
 * (`transliterated` lists the fields changed).
 */
export function debtorFromProfile(org: {
  legalName: string | null;
  registrationNumber: string | null;
  addressLine1: string | null;
  addressLine2?: string | null;
  addressCity: string | null;
  addressState: string | null;
  addressPostalCode: string | null;
  addressCountry: string | null;
}): { party: Iso20022Party | null; missing: string[]; transliterated: string[] } {
  const missing: string[] = [];
  if (!org.legalName?.trim()) missing.push('legalName');
  if (!org.registrationNumber?.trim()) missing.push('registrationNumber');
  if (!org.addressCity?.trim()) missing.push('addressCity');
  if (!org.addressCountry?.trim()) missing.push('addressCountry');
  if (missing.length) return { party: null, missing, transliterated: [] };
  const changed: string[] = [];
  try {
    const party = normalizeParty(
      {
        name: org.legalName,
        registrationNumber: org.registrationNumber,
        address: {
          streetName: org.addressLine1 ?? undefined,
          buildingName: org.addressLine2 ?? undefined,
          townName: org.addressCity,
          countrySubDivision: org.addressState ?? undefined,
          postCode: org.addressPostalCode ?? undefined,
          country: org.addressCountry,
        },
      },
      { field: 'debtor', requireAddress: true, requireRegistration: true, lenient: { changed } },
    );
    return { party, missing: [], transliterated: [...new Set(changed)] };
  } catch (error) {
    return { party: null, missing: [error instanceof Iso20022Error ? error.field : 'debtor'], transliterated: [] };
  }
}
