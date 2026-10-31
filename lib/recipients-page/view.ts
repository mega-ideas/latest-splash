/**
 * The Recipients page (v2 brief 5.9): five kinds of recipient, each with a
 * verification state in words, and what a person may do about it.
 *
 * It only words what the server already decided. The gates are the server's
 * (lib/server/wallet-recipients.ts `walletDeliveryGate`, the approval and
 * proof routes); this reads the same facts so the page can say what is
 * missing and who can supply it, in the order the gate checks them: a failed
 * screening, a proof the supplier has not given, a screening still to do, and
 * an owner's approval. Pure and client-safe.
 */
import { PARTNERS, isPartnerId } from '../partners/signed-partners.ts';
import type { ClientRecipient } from './wire.ts';

export type RecipientKind = 'bank' | 'splash_business' | 'exchange' | 'self_custody' | 'cross_chain';

export const RECIPIENT_KINDS: ReadonlyArray<{ id: RecipientKind; label: string; blurb: string }> = [
  { id: 'bank', label: 'Bank account', blurb: 'A supplier’s account, paid in local currency. The bank confirms the holder’s name before it is saved.' },
  { id: 'splash_business', label: 'Splash business', blurb: 'A business with its own Splash Wallet. Found by registered name; paying it costs nothing.' },
  { id: 'exchange', label: 'Exchange account', blurb: 'A deposit address at an exchange, on Sui.' },
  { id: 'self_custody', label: 'Self-custody wallet', blurb: 'A wallet the supplier holds. Paid once they prove it is theirs.' },
  { id: 'cross_chain', label: 'Another chain', blurb: 'USDC on Ethereum, Base, Arbitrum, Solana and others, delivered over CCTP.' },
];

export type Tone = 'ok' | 'wait' | 'bad';
export type StateStep = 'ready' | 'saved' | 'blocked' | 'proof' | 'screening' | 'approval' | 'older';
export type RecipientState = { step: StateStep; tone: Tone; label: string; detail: string };
export type Action = 'send_proof' | 'approve' | 'withdraw_proof' | 'remove';

/** The facts of a payee already paid, from `GET /api/wallet/transfers`. */
export type PaidPayee = { id: string; paymentRef: string; payeeKind: string; payeeName: string; payeeMasked: string | null; payeeCountry: string | null; createdAt: string; status: string };

/** A supplier's bank account, from `GET /api/wallet/payouts/beneficiaries`. */
export type BankAccount = { id: string; route: string; country: string; currency: string; bankCode: string; holderName: string; last4: string; label: string; status: string };

export type Entry = {
  /** The record's id; a business on Splash has its payment's id. */
  id: string;
  source: 'saved' | 'beneficiary' | 'splash_business';
  kind: RecipientKind;
  name: string;
  subtitle: string;
  /** The account or address, shortened. */
  masked: string;
  /** The whole address of a wallet, exchange or other-chain recipient; empty for a bank account or a business. A person reads it before approving. */
  address: string;
  country: string;
  state: RecipientState;
  searchText: string;
  /** For the self-custody and cross-chain facts the page needs for actions. */
  facts: { proven: boolean; approved: boolean; savedByYou: boolean; payable: boolean; hasEmail: boolean };
};

export const maskAddress = (address: string | null | undefined): string => {
  const a = String(address ?? '');
  return a.length > 14 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
};

/**
 * An exchange is described by its role, never by name: a partner is named only
 * once its agreement is signed (lib/partners/signed-partners.ts), and the page
 * cannot know that.
 */
const exchangeRole = (id: string | null | undefined): string => {
  const role = id && isPartnerId(id) ? PARTNERS[id].role : 'An exchange';
  return role.charAt(0).toUpperCase() + role.slice(1);
};

/** A bank account number is never shown whole: its last four digits. */
export const maskAccount = (account: string | null | undefined): string => {
  const digits = String(account ?? '').replace(/[\s•]/g, '');
  return digits.length === 0 ? '' : `••${digits.slice(-4)}`;
};

export function kindOfRecipient(r: Pick<ClientRecipient, 'delivery' | 'payoutMethod'>): Exclude<RecipientKind, 'splash_business'> {
  switch (r.delivery?.deliveryKind) {
    case 'EXCHANGE':
      return 'exchange';
    case 'SELF_CUSTODY':
      return 'self_custody';
    case 'CROSS_CHAIN':
      return 'cross_chain';
    case 'BANK':
      return 'bank';
    default:
      return r.payoutMethod === 'WALLET' ? 'self_custody' : r.payoutMethod === 'CROSS_CHAIN' ? 'cross_chain' : 'bank';
  }
}

const READY: RecipientState = { step: 'ready', tone: 'ok', label: 'Ready to pay', detail: 'Screened, approved by an owner, and checked.' };

/** What is missing, in the order the payment gate checks it. */
export function stateOf(r: ClientRecipient): RecipientState {
  const kind = kindOfRecipient(r);
  if (kind === 'bank') {
    // Neither can be paid from here: the bank has not confirmed the holder's name for an older entry, whatever its business check says.
    return r.kybStatus === 'full'
      ? { step: 'older', tone: 'wait', label: 'Business checked, add it again', detail: 'The business was checked, but this account was never confirmed with the bank. To pay it, add it again in Transfer, where the bank confirms the name.' }
      : { step: 'older', tone: 'wait', label: 'Not verified', detail: 'To pay this account, add it again in Transfer, where the bank confirms the name.' };
  }
  const verdict = r.screeningVerdict ?? null;
  if (verdict === 'BLOCK') return { step: 'blocked', tone: 'bad', label: 'Did not pass screening', detail: 'This address cannot be paid.' };
  if (kind === 'self_custody') {
    const proof = r.delivery?.ownershipStatus ?? 'unproven';
    if (proof === 'revoked') return { step: 'proof', tone: 'wait', label: 'Proof withdrawn', detail: 'No payment to this wallet until the supplier proves it again.' };
    if (proof !== 'proven') return { step: 'proof', tone: 'wait', label: 'Waiting for the supplier to prove the wallet', detail: 'Send them the proof link. They sign a message with the wallet; nothing moves.' };
  }
  // An owner's own statement is not a screening, and an old one does not stand in for it.
  if (verdict !== 'CLEAR') {
    return verdict === 'ERROR'
      ? { step: 'screening', tone: 'bad', label: 'Screening did not complete', detail: 'It cannot be paid until the address has been screened.' }
      : { step: 'screening', tone: 'wait', label: 'Screening not complete', detail: 'It cannot be paid until the address has been screened.' };
  }
  if (!r.approvedAt) return { step: 'approval', tone: 'wait', label: 'Waiting for an owner’s approval', detail: r.savedByYou ? 'Another owner approves a recipient you saved.' : 'An owner approves it before it can be paid.' };
  if (kind === 'cross_chain') {
    return { step: 'saved', tone: 'ok', label: 'Screened and approved', detail: 'USDC to another chain is not switched on for your business yet, so it cannot be paid from here.' };
  }
  return kind === 'exchange' ? { ...READY, detail: 'Screened and approved by an owner.' } : { ...READY, detail: 'The supplier proved the wallet, and it is screened and approved.' };
}

function savedEntry(r: ClientRecipient): Entry {
  const kind = kindOfRecipient(r);
  const state = stateOf(r);
  const address = r.walletAddress ?? r.delivery?.destinationAddress ?? '';
  const place = kind === 'exchange' ? r.delivery?.exchangeId : kind === 'cross_chain' ? r.delivery?.destinationChain : null;
  const subtitle =
    kind === 'bank'
      ? [r.bank, 'Older entry'].filter(Boolean).join(' · ')
      : kind === 'exchange'
        ? `${exchangeRole(place)} · Sui`
        : kind === 'cross_chain'
          ? `${String(place ?? 'Another chain')} · USDC`
          : `${r.walletProvider === 'METAMASK_SUI_SNAP' ? 'MetaMask (Sui Snap)' : r.walletProvider === 'BACKPACK' ? 'Backpack' : r.walletProvider === 'OTHER' ? 'Another wallet' : 'Slush'} · USDC on Sui`;
  return {
    id: r.id,
    source: 'saved',
    kind,
    name: r.name,
    subtitle,
    masked: kind === 'bank' ? maskAccount(r.account) : maskAddress(address),
    address: kind === 'bank' ? '' : address,
    country: r.country,
    state,
    searchText: [r.name, r.bank, address, place, r.supplier?.legalName].filter(Boolean).join(' ').toLowerCase(),
    facts: {
      proven: r.delivery?.ownershipStatus === 'proven',
      approved: Boolean(r.approvedAt),
      savedByYou: r.savedByYou,
      payable: state.step === 'ready',
      hasEmail: r.hasEmail,
    },
  };
}

function bankEntry(b: BankAccount): Entry {
  return {
    id: b.id,
    source: 'beneficiary',
    kind: 'bank',
    name: b.holderName,
    subtitle: `${b.label && b.label !== b.holderName ? `${b.label} · ` : ''}${b.currency} · ${b.bankCode}`,
    masked: `••${b.last4}`,
    address: '',
    country: b.country,
    state: { step: 'ready', tone: 'ok', label: 'Verified with the bank', detail: 'The bank confirmed the account holder’s name before it was saved.' },
    searchText: [b.holderName, b.label, b.bankCode, b.country].filter(Boolean).join(' ').toLowerCase(),
    facts: { proven: true, approved: true, savedByYou: false, payable: true, hasEmail: false },
  };
}

/** The businesses on Splash a business has paid, once each, the most recent first. */
function businessEntries(transfers: PaidPayee[]): Entry[] {
  const seen = new Map<string, { latest: PaidPayee; count: number }>();
  for (const t of transfers) {
    if (t.payeeKind !== 'splash_business') continue;
    // Two businesses can share a registered name; their wallets differ.
    const key = `${t.payeeName.trim().toLowerCase()}|${(t.payeeMasked ?? '').toLowerCase()}`;
    const found = seen.get(key);
    if (!found) seen.set(key, { latest: t, count: 1 });
    else {
      found.count += 1;
      if (t.createdAt > found.latest.createdAt) found.latest = t;
    }
  }
  return [...seen.values()]
    .sort((a, b) => b.latest.createdAt.localeCompare(a.latest.createdAt))
    .map(({ latest, count }) => ({
      id: latest.id,
      source: 'splash_business' as const,
      kind: 'splash_business' as const,
      name: latest.payeeName,
      subtitle: `${count} ${count === 1 ? 'payment' : 'payments'} · last ${latest.createdAt.slice(0, 10)}`,
      masked: '',
      address: '',
      country: latest.payeeCountry ?? '',
      state: { step: 'ready' as const, tone: 'ok' as const, label: 'On Splash', detail: 'Found by its registered name in Transfer. Paying it costs nothing.' },
      searchText: latest.payeeName.toLowerCase(),
      facts: { proven: true, approved: true, savedByYou: false, payable: true, hasEmail: false },
    }));
}

export function buildEntries(input: { saved: ClientRecipient[]; beneficiaries: BankAccount[]; transfers: PaidPayee[] }): Entry[] {
  const bankIds = new Set(input.beneficiaries.map((b) => b.id));
  return [
    ...input.beneficiaries.map(bankEntry),
    ...input.saved.filter((r) => !bankIds.has(r.id)).map(savedEntry),
    ...businessEntries(input.transfers),
  ];
}

export function countByKind(entries: Entry[]): Record<RecipientKind | 'all', number> {
  const counts: Record<RecipientKind | 'all', number> = { all: entries.length, bank: 0, splash_business: 0, exchange: 0, self_custody: 0, cross_chain: 0 };
  for (const e of entries) counts[e.kind] += 1;
  return counts;
}

export function filterEntries(entries: Entry[], input: { kind: RecipientKind | 'all'; query: string }): Entry[] {
  const q = input.query.trim().toLowerCase();
  return entries.filter((e) => (input.kind === 'all' || e.kind === input.kind) && (q === '' || e.searchText.includes(q)));
}

const MANAGERS = new Set(['OWNER', 'MAKER', 'APPROVER']);

/**
 * What this person may do. It mirrors what the routes allow, so the page never
 * offers a button the server will refuse: owners and staff ask for the proof
 * link; only an owner approves (not what they saved themselves), withdraws a
 * proof, removes a recipient that can be paid, or removes a supplier's bank
 * account; a viewer changes nothing.
 */
export function actionsFor(entry: Entry, role: string): Action[] {
  if (!MANAGERS.has(role)) return [];
  const owner = role === 'OWNER';
  if (entry.source === 'splash_business') return [];
  if (entry.source === 'beneficiary') return owner ? ['remove'] : [];
  const actions: Action[] = [];
  const wallet = entry.kind === 'exchange' || entry.kind === 'self_custody' || entry.kind === 'cross_chain';
  // Staff are not shown the link; it goes to the supplier's email, so without one there is nothing for them to send.
  if (wallet && entry.kind === 'self_custody' && !entry.facts.proven && (owner || entry.facts.hasEmail)) actions.push('send_proof');
  // Approving is what makes an address payable: it is offered only once the address has been screened clean (and, for a wallet, proven), the point at which the state reads 'waiting for an owner's approval'.
  if (wallet && owner && !entry.facts.approved && !entry.facts.savedByYou && entry.state.step === 'approval') actions.push('approve');
  if (owner && entry.kind === 'self_custody' && entry.facts.proven) actions.push('withdraw_proof');
  // What can be paid is the owners' to remove; what cannot be paid yet is anyone's who manages recipients.
  const payable = entry.facts.payable || (entry.kind === 'self_custody' && entry.facts.proven);
  if (owner || !payable) actions.push('remove');
  return actions;
}

const norm = (a: string | null | undefined) => String(a ?? '').trim().toLowerCase();

/** Whether the business's spending policy still lets staff pay this address on the chain. */
export function policyHolds(policy: { recipients: Array<{ address: string }> } | null | undefined, address: string): boolean {
  const a = norm(address);
  return a !== '' && (policy?.recipients ?? []).some((r) => norm(r.address) === a);
}

/**
 * What Remove says. The list here is Splash's own; the spending policy is on
 * the chain and is changed only by the owners' signatures, so removing a wallet
 * from this list does not take it off the policy. Until the owners stop
 * allowing it, a staff member can still pay that address under their rule
 * directly on the chain (Splash's own payment path refuses it).
 * `onPolicy` is null when the policy could not be read.
 */
export function removeWords(entry: Pick<Entry, 'name' | 'source' | 'kind'>, onPolicy: boolean | null): string {
  const base = `${entry.name} is taken off your list. ${entry.source === 'beneficiary' ? 'A payment to this account that has not been sent is cancelled.' : 'Payments you have already made are not affected.'} You can save them again later.`;
  const wallet = entry.source === 'saved' && (entry.kind === 'self_custody' || entry.kind === 'exchange');
  if (!wallet || onPolicy === false) return base;
  return onPolicy === true
    ? `${base} This address is on your spending policy, and removing it here does not take it off. Staff can still pay it under their rule on the chain until your owners choose Stop allowing in Settings.`
    : `${base} If this address is on your spending policy, removing it here does not take it off. Check under Stop allowing in Settings.`;
}
