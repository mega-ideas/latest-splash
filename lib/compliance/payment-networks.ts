/**
 * The payment network a person knows, per corridor (v2 Phase 3, Sky's decision).
 *
 * The confirmation a staff member reads before paying an exchange account
 * names the NETWORK the money travels on ("DuitNow" for a Malaysia payout) and
 * never the processor or institution behind it ("Fiuu"), even after a partner
 * agreement is signed. This is the one place the map from corridor to network
 * name lives; the bank payout list (lib/transfer/payee.ts) reads its names from
 * here too. Pure and client-safe.
 *
 * The exception. Where a reviewer, a regulator or legal advice requires the
 * receiving institution to be named, it must be named, to avoid legal
 * exposure. Each corridor carries `mustNameReceivingInstitution`, false by
 * default. It is changed ONLY in code, by Splash compliance, in a reviewed
 * commit: it is not an owner's setting, not a user's switch, not read from the
 * database, the environment or a request. Where it is true the confirmation
 * names the real institution next to the network name, and the rule that bans
 * naming partners has a recorded exception for exactly those corridors
 * (`INSTITUTION_NAMING_EXCEPTIONS`, tested). The Travel Rule message to the
 * provider is not touched by any of this: it carries the real counterparty
 * data the law needs. Only the words on the screen change.
 */
import { PARTNERS, isPartnerId } from '../partners/signed-partners.ts';

export type Corridor = 'MY' | 'PH' | 'ID' | 'TH' | 'VN' | 'SG';

export type NetworkEntry = {
  /** The country, as the screen says it. */
  country: string;
  /** The public scheme the person knows. */
  network: string;
  /** Compliance only, in code: name the real receiving institution beside the network. False unless a reviewer, regulator or legal advice requires it. */
  mustNameReceivingInstitution: boolean;
};

export type NetworkTable = Readonly<Record<Corridor, NetworkEntry>>;

export const PAYMENT_NETWORKS: NetworkTable = {
  MY: { country: 'Malaysia', network: 'DuitNow', mustNameReceivingInstitution: false },
  PH: { country: 'the Philippines', network: 'InstaPay or PESONet', mustNameReceivingInstitution: false },
  ID: { country: 'Indonesia', network: 'BI-FAST', mustNameReceivingInstitution: false },
  TH: { country: 'Thailand', network: 'PromptPay', mustNameReceivingInstitution: false },
  VN: { country: 'Vietnam', network: 'Napas', mustNameReceivingInstitution: false },
  SG: { country: 'Singapore', network: 'FAST', mustNameReceivingInstitution: false },
};

export const CORRIDORS = Object.keys(PAYMENT_NETWORKS) as Corridor[];

/** The corridor each exchange Splash can pay sits in (lib/compliance/sumsub.ts TRAVEL_RULE_EXCHANGES). */
export const EXCHANGE_CORRIDORS: Readonly<Record<string, Corridor>> = {
  hata: 'MY',
  pdax: 'PH',
  tokocrypto: 'ID',
  bitkub: 'TH',
};

const corridorOf = (country: unknown): Corridor | null => {
  const c = String(country ?? '').trim().toUpperCase();
  return (CORRIDORS as string[]).includes(c) ? (c as Corridor) : null;
};

/** The network name for a country code, or null for a country that is not a corridor. */
export function networkNameOf(country: string, table: NetworkTable = PAYMENT_NETWORKS): string | null {
  const corridor = corridorOf(country);
  return corridor ? table[corridor].network : null;
}

/** Must the receiving institution be named for this corridor? Code only; false unless compliance set it. */
export function mustNameInstitution(country: string, table: NetworkTable = PAYMENT_NETWORKS): boolean {
  const corridor = corridorOf(country);
  return corridor ? table[corridor].mustNameReceivingInstitution === true : false;
}

/** The corridors where the ban on naming a partner has a recorded exception: exactly those flagged. */
export function institutionNamingExceptions(table: NetworkTable = PAYMENT_NETWORKS): readonly Corridor[] {
  return CORRIDORS.filter((c) => table[c].mustNameReceivingInstitution === true);
}

/**
 * The recorded exceptions to the ban on naming a partner: a reviewed list, written out by hand, not computed from the flags above. A
 * corridor goes on this list in the same commit that sets its `mustNameReceivingInstitution` flag, and a test fails if the two disagree,
 * so flagging a corridor without recording the exception (or the reverse) cannot pass review unnoticed. Empty as shipped.
 */
export const INSTITUTION_NAMING_EXCEPTIONS: readonly Corridor[] = [];

export type NetworkWords = {
  corridor: Corridor | null;
  /** The country, as the screen says it ("Malaysia"). */
  country: string;
  /** The network the person knows. */
  network: string;
  /** The real receiving institution, only for a flagged corridor. */
  institution: string | null;
  /** What the screen says: the network, with the institution beside it where it must be named. */
  text: string;
};

/**
 * What the confirmation says about where the payment goes, for the exchange the account is held at. It is never
 * told which partners are signed: the network is named whether or not an agreement is.
 */
export function networkWords(exchangeId: string, table: NetworkTable = PAYMENT_NETWORKS): NetworkWords {
  const corridor = Object.hasOwn(EXCHANGE_CORRIDORS, exchangeId) ? EXCHANGE_CORRIDORS[exchangeId] : null;
  if (!corridor) return { corridor: null, country: 'the exchange’s country', network: 'the exchange’s payment network', institution: null, text: 'the exchange’s payment network' };
  const entry = table[corridor];
  const institution = entry.mustNameReceivingInstitution === true && isPartnerId(exchangeId) ? PARTNERS[exchangeId].name : null;
  return { corridor, country: entry.country, network: entry.network, institution, text: institution ? `${entry.network}, received by ${institution}` : entry.network };
}
