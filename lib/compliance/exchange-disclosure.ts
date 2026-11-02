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
 * Whose name goes (Sky's decision): by default "Sent by NAME (Title): purpose".
 * If the business (an owner's switch) or the person (their own switch) chose
 * not to share a name, the payload holds no name at all and the details read
 * "Sent by COMPANY NAME: purpose". The switches change only this: what the
 * exchange is told and what this screen shows. The audit record is not made
 * here and is not affected.
 *
 * Nothing here decides whether a payment is allowed. It says what travels.
 */
import { formatUsdc } from '../fees/copy.ts';
import { networkWords, PAYMENT_NETWORKS, type NetworkTable } from './payment-networks.ts';

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
  /**
   * Who started the payment. `userId` is always kept (an internal id). `name` and `title` are the person's and are set ONLY when both the
   * business and the person allow their name to go to the exchange; otherwise `name` is null and the exchange is told the business sent it.
   * A message made before titles existed has no `title` key at all, and its text and hash are unchanged.
   */
  sender: { userId: string; name: string | null; title?: string | null };
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
    sender: { userId: d.sender.userId, name: d.sender.name, ...(typeof d.sender.title === 'string' ? { title: d.sender.title } : {}) },
    business: { ...party(d.business), walletAddress: d.business.walletAddress },
    beneficiary: { ...party(d.beneficiary), exchange: d.beneficiary.exchange, accountReference: d.beneficiary.accountReference },
    purpose: { code: d.purpose.code, label: d.purpose.label },
  };
}

/** The exact text that is hashed and kept. */
export function canonicalDisclosure(d: ExchangeDisclosure): string {
  return JSON.stringify(ordered(d));
}

/** Control, hidden and direction-changing characters: they become spaces, so a name cannot break a line or reorder what is read. */
const HIDDEN = new RegExp('[\u0000-\u001f\u007f-\u009f\u00ad\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]', 'g');

/** Printable, single-line plain words, cut to `max`. */
const plain = (value: string | null | undefined, max: number) => (value ?? '').replace(HIDDEN, ' ').replace(/\s+/g, ' ').trim().slice(0, max).trim();

/** A person's name or title as it travels: also without brackets, so a name can never dress itself as a title ("Eve (CEO)"). */
const personal = (value: string | null | undefined, max: number) => plain((value ?? '').replace(/[()]/g, ' '), max);

/**
 * Who the exchange is told sent the payment, and the screen says the same. "NAME (Title)" while the business and the person both allow
 * their name to go; otherwise the paying business and no person at all. A payload with no name never says a title.
 */
export function senderOf(d: ExchangeDisclosure): string {
  const name = personal(d.sender.name, 40);
  if (name) {
    const title = personal(d.sender.title, 40);
    return title ? `${name} (${title})` : name;
  }
  return plain(d.business.legalName, 80) || 'the business';
}

/** Does this message name a person? Only when a name was allowed to travel. */
export const namesAPerson = (d: ExchangeDisclosure): boolean => personal(d.sender.name, 40) !== '';

/** What the provider is told the payment is for: who sends it first, then why. At most 140 characters. */
export function purposeTextOf(d: ExchangeDisclosure): string {
  return `Sent by ${senderOf(d)}: ${d.purpose.label}`.slice(0, 140);
}

export type DisclosureText = {
  headline: string;
  /** The same facts as label and value, for a page that lays them out. */
  rows: Array<{ label: string; value: string }>;
  /** Whose name goes, in plain words: the business's choice and the person's own are both theirs to make in Settings. */
  notes: string[];
  /** Where the details go and exactly what is shared. */
  sharing: string;
  /** Every fact as one line, then what Splash does with it. The last two lines close the message. */
  lines: string[];
};

const place = (p: DisclosureParty) => [p.town, p.country].map((v) => (v ?? '').trim()).filter(Boolean).join(', ');

/**
 * The message in plain words. The place the money goes is named by the payment network the person knows; the processor or institution
 * behind it is never named, except for a corridor Splash compliance flagged as one that must name it (lib/compliance/payment-networks.ts).
 * What is said of the sender is exactly what the provider is told.
 */
export function disclosureText(d: ExchangeDisclosure, table: NetworkTable = PAYMENT_NETWORKS): DisclosureText {
  const where = networkWords(d.beneficiary.exchange, table);
  const reg = (n: string | null) => (n ? ` (registration ${n})` : '');
  const rows = [
    { label: 'Sent by', value: senderOf(d) },
    { label: 'From the business', value: `${d.business.legalName}${reg(d.business.registrationNumber)}, ${place(d.business)}` },
    { label: 'Business wallet', value: d.business.walletAddress },
    { label: 'To', value: `${d.beneficiary.legalName}${reg(d.beneficiary.registrationNumber)}, ${place(d.beneficiary)}` },
    // The network the person knows, never the company behind it.
    { label: 'Payment network', value: where.text },
    { label: 'Account at the exchange', value: d.beneficiary.accountReference },
    { label: 'Amount', value: `${formatUsdc(BigInt(d.amountMinor))} USDC` },
    { label: 'Purpose', value: d.purpose.label },
    // Exactly the string the provider is sent as the payment's details.
    { label: 'Payment details as sent', value: purposeTextOf(d) },
  ];
  const notes = namesAPerson(d)
    ? [`Your name${personal(d.sender.title, 40) ? ' and job title are' : ' is'} sent to the exchange, because your business and you both allow it. You can stop sharing your own in Settings.`]
    : ['No person’s name or job title is sent. The exchange is told your business sent this payment. Your business’s owners and you each decide this in Settings.'];
  const sharing = `These details are shared with the payout partner in ${where.country} that receives this payment over ${where.text}: the business’s registered name, registration number, address and wallet; the recipient’s registered name, registration number, address and account; the amount; and the payment details above.`;
  return {
    headline: 'What will be shared with the exchange',
    rows,
    notes,
    sharing,
    lines: [
      ...rows.map((r) => `${r.label}: ${r.value}.`),
      ...notes,
      sharing,
      'Splash sends this once, for this payment only, to the exchange that holds the account, through its Travel Rule provider. The exchange uses it to check the payment against the account.',
      'Nothing is sent until you confirm. If any of it is wrong, do not confirm; go back and check the recipient.',
    ],
  };
}
