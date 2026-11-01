/**
 * What is shared with an exchange when a staff member pays one of its accounts
 * alone (v2 Phase 3), as data and as words. Pure and client-safe.
 *
 * Before the person signs, Transfer shows this message and asks them to
 * confirm it. The server builds the same payload itself from what it holds
 * (the signed-in person, the business the provider verified, the saved
 * recipient and its exchange, the amount) plus the purpose the person picked
 * from the list below, and compares the hash of the text the person saw with
 * the hash of its own. What is kept with the payment is that exact payload
 * (`canonicalDisclosure`), bound to the intent id, and the message sent to the
 * Travel Rule provider is made from it (`travelRuleInputFromDisclosure`), so
 * what was read, what was recorded and what was sent are one thing.
 *
 * Nothing here decides whether a payment is allowed. It says what travels.
 */
import { formatUsdc } from '../fees/copy.ts';
import { partnerLabel, isPartnerId, type PartnerId } from '../partners/signed-partners.ts';

/** The reasons a person can give for paying an exchange account. A short, fixed list: anything else is refused. */
export const EXCHANGE_PURPOSES = [
  { code: 'invoice', label: 'Paying a supplier invoice' },
  { code: 'goods_services', label: 'Buying goods or services' },
  { code: 'contractor', label: 'Paying a contractor or freelancer' },
  { code: 'refund', label: 'A refund to a customer' },
  { code: 'other_business', label: 'Another business expense' },
] as const;

export type ExchangePurposeCode = (typeof EXCHANGE_PURPOSES)[number]['code'];

/** The purpose a code names, or null for anything that is not on the list. */
export function exchangePurpose(code: unknown): { code: ExchangePurposeCode; label: string } | null {
  return typeof code === 'string' ? (EXCHANGE_PURPOSES.find((p) => p.code === code) ?? null) : null;
}

export type DisclosureParty = {
  legalName: string;
  registrationNumber: string | null;
  /** ISO 3166 alpha-2. */
  country: string;
  town: string | null;
  street: string | null;
  postCode: string | null;
};

/** The payload: exactly what is confirmed, kept, and sent. */
export type ExchangeDisclosure = {
  version: 1;
  /** The client's intent id (the Idempotency-Key). */
  intentId: string;
  /** The payment reference derived from it, 0x and 64 hex: how the chain and the stored records know the payment. */
  paymentRef: string;
  /** USDC, 6 decimals. */
  amountMinor: string;
  asset: 'USDC';
  sender: { userId: string; name: string };
  business: DisclosureParty & { walletAddress: string };
  beneficiary: DisclosureParty & { exchange: string; accountReference: string };
  purpose: { code: ExchangePurposeCode; label: string };
};

/** Keys in a fixed order, so the same facts always make the same text, and so the same hash. */
function ordered(d: ExchangeDisclosure) {
  const party = (p: DisclosureParty) => ({
    legalName: p.legalName,
    registrationNumber: p.registrationNumber,
    country: p.country,
    town: p.town,
    street: p.street,
    postCode: p.postCode,
  });
  return {
    version: d.version,
    intentId: d.intentId,
    paymentRef: d.paymentRef,
    amountMinor: d.amountMinor,
    asset: d.asset,
    sender: { userId: d.sender.userId, name: d.sender.name },
    business: { ...party(d.business), walletAddress: d.business.walletAddress },
    beneficiary: { ...party(d.beneficiary), exchange: d.beneficiary.exchange, accountReference: d.beneficiary.accountReference },
    purpose: { code: d.purpose.code, label: d.purpose.label },
  };
}

/** The exact text that is hashed and kept. */
export function canonicalDisclosure(d: ExchangeDisclosure): string {
  return JSON.stringify(ordered(d));
}

/** What the provider is told the payment is for: who sends it first, then why. At most 140 characters. */
export function purposeTextOf(d: ExchangeDisclosure): string {
  const name = d.sender.name.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 40) || 'a team member';
  return `Sent by ${name}: ${d.purpose.label}`.slice(0, 140);
}

export type DisclosureText = {
  headline: string;
  /** The same facts as label and value, for a page that lays them out. */
  rows: Array<{ label: string; value: string }>;
  /** Every fact as one line, then what Splash does with it. */
  lines: string[];
};

const place = (p: DisclosureParty) => [p.town, p.country].map((v) => (v ?? '').trim()).filter(Boolean).join(', ');

/**
 * The message in plain words. An exchange is named only when its agreement is
 * signed (`signed`); otherwise it is described as Recipients describes it.
 */
export function disclosureText(d: ExchangeDisclosure, signed: ReadonlySet<PartnerId> = new Set()): DisclosureText {
  const exchange = isPartnerId(d.beneficiary.exchange) ? partnerLabel(d.beneficiary.exchange, signed) : 'the exchange';
  const reg = (n: string | null) => (n ? ` (registration ${n})` : '');
  const rows = [
    { label: 'Sent by', value: d.sender.name },
    { label: 'From the business', value: `${d.business.legalName}${reg(d.business.registrationNumber)}, ${place(d.business)}` },
    { label: 'Business wallet', value: d.business.walletAddress },
    { label: 'To', value: `${d.beneficiary.legalName}${reg(d.beneficiary.registrationNumber)}, ${place(d.beneficiary)}` },
    { label: 'Exchange', value: exchange },
    { label: 'Account at the exchange', value: d.beneficiary.accountReference },
    { label: 'Amount', value: `${formatUsdc(BigInt(d.amountMinor))} USDC` },
    { label: 'Purpose', value: d.purpose.label },
  ];
  return {
    headline: 'What will be shared with the exchange',
    rows,
    lines: [
      ...rows.map((r) => `${r.label}: ${r.value}.`),
      'Splash sends this once, for this payment only, to the exchange that holds the account, through its Travel Rule provider. The exchange uses it to check the payment against the account.',
      'Nothing is sent until you confirm. If any of it is wrong, do not confirm; go back and check the recipient.',
    ],
  };
}
