/**
 * Wallet recipients (v2 §4.7, D5): what each kind of on-chain recipient is,
 * how its fields are checked, and what the Move side needs from it.
 *
 *   EXCHANGE      a supplier's deposit address at an exchange (D5a). The
 *                 exchange is one of TRAVEL_RULE_EXCHANGES and is named in
 *                 copy only once its agreement is signed
 *                 (lib/partners/signed-partners.ts). The deposit is on Sui:
 *                 Splash pays USDC on Sui, and the sender-declaration pack
 *                 and the Travel Rule message both say so. Paid as kind
 *                 EXCHANGE (2); on a SpendPolicy, the EXCHANGE tag.
 *   SELF_CUSTODY  any wallet the supplier holds itself (D5b). The wallet app
 *                 (Slush, Phantom, MetaMask, Backpack) is a label only. Not
 *                 paid until the supplier signs the ownership proof (below)
 *                 with the address's own key. Paid as kind WALLET (1); on a
 *                 SpendPolicy, the WALLET tag, which the policy grants only
 *                 for a proven address.
 *   CROSS_CHAIN   USDC on another chain over CCTP V2 (D5c, D13). USDC only.
 *                 The address is checked against its chain's own format and
 *                 written as CCTP's 32-byte mint recipient. Paid as kind
 *                 CROSS_CHAIN (3), from the owners' multisig only: the Move
 *                 refuses it on a spending rule (splash_spend
 *                 E_WRONG_PAY_PATH), and so does every server path.
 *
 * Every kind carries the supplier's business details: the name, registration
 * number, country and registered address a Travel Rule message, a sender
 * declaration and the controls evidence need. They are the supplier's, typed
 * by the paying business, and labelled so wherever they are shown.
 *
 * Pure: no database, no network. lib/server/wallet-recipients.ts stores and
 * gates them.
 */
import { normalizeSuiAddress } from '@mysten/sui/utils';

import { isTravelRuleExchange, TRAVEL_RULE_EXCHANGES, type TravelRuleExchange } from '../compliance/sumsub.ts';
import {
  evmMintRecipient,
  FUNDING_CHAINS,
  FundingPlanError,
  solanaTokenAccountMintRecipient,
  type CctpPeerChain,
} from '../payments/cctp.ts';

export const DELIVERY_KINDS = ['BANK', 'EXCHANGE', 'SELF_CUSTODY', 'CROSS_CHAIN'] as const;
export type DeliveryKind = (typeof DELIVERY_KINDS)[number];
export const isDeliveryKind = (v: unknown): v is DeliveryKind => typeof v === 'string' && (DELIVERY_KINDS as readonly string[]).includes(v);

/** splash_core's intent kinds (fee_config), as lib/server/sui-v2-builders.ts V2_KIND. */
export const MOVE_KIND = Object.freeze({ SPLASH_BUSINESS: 0, WALLET: 1, EXCHANGE: 2, CROSS_CHAIN: 3, BANK_PAYOUT: 4 });
/** splash_spend's recipient tags (lib/server/spend-rules-builders.ts RECIPIENT_TAG). */
export const POLICY_TAG = Object.freeze({ WALLET: 1, EXCHANGE: 2 });

/**
 * The wallet app a self-custody supplier says it uses. A label: it decides
 * nothing. D5 names Slush, Phantom, MetaMask and Backpack; Phantom is not
 * offered because it ended Sui support (the table refuses it since 0020),
 * and MetaMask holds a Sui address only through the Sui Snap. Any other
 * wallet is OTHER.
 */
export const WALLET_LABELS = ['SLUSH', 'METAMASK_SUI_SNAP', 'BACKPACK', 'OTHER'] as const;
export type WalletLabel = (typeof WALLET_LABELS)[number];

/** The only networks an exchange deposit address may be on. Splash pays USDC on Sui. */
export const EXCHANGE_NETWORKS = ['SUI'] as const;

/**
 * The chains a cross-chain recipient may be on: CCTP V2 chains Circle lists
 * with USDC that Splash can also screen (lib/compliance/kyt.ts
 * SCREENING_CHAINS), each with the name screening uses. A chain Splash
 * cannot screen is not paid: a payment is opened only for a CLEAR.
 */
export const CROSS_CHAIN_CHAINS = {
  ETHEREUM: 'ETHEREUM',
  BASE: 'BASE',
  ARBITRUM: 'ARBITRUM',
  OP_MAINNET: 'OPTIMISM',
  POLYGON_POS: 'POLYGON',
  AVALANCHE: 'AVALANCHE',
  SOLANA: 'SOLANA',
} as const satisfies Partial<Record<CctpPeerChain, string>>;
export type CrossChainChain = keyof typeof CROSS_CHAIN_CHAINS;
export const isCrossChainChain = (v: unknown): v is CrossChainChain => typeof v === 'string' && Object.hasOwn(CROSS_CHAIN_CHAINS, v);

export class RecipientInputError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'RecipientInputError';
    this.code = code;
  }
}

/** The supplier's business, as the paying business typed it. */
export type SupplierDetails = {
  /** Trading name, shown in lists. */
  name: string;
  legalName: string;
  registrationNumber: string;
  /** ISO 3166-1 alpha-2. */
  country: string;
  addressLine1: string;
  addressCity: string;
  addressPostalCode: string | null;
  /** Where the ownership-proof link is sent. */
  email: string | null;
};

/** Printable, single-line, cut short. Null when nothing is left. */
function text(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const v = value.replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
  return v || null;
}

function required(value: unknown, max: number, code: string, message: string): string {
  const v = text(value, max);
  if (!v) throw new RecipientInputError(code, message);
  return v;
}

export function parseSupplierDetails(body: Record<string, unknown>): SupplierDetails {
  const legalName = required(body.legalName, 140, 'supplier_details_missing', "Enter the supplier's registered business name.");
  const name = text(body.name, 140) ?? legalName;
  const registrationNumber = required(body.registrationNumber, 64, 'supplier_details_missing', "Enter the supplier's company registration number.");
  const country = String(body.country ?? '').trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(country)) throw new RecipientInputError('bad_country', "Enter the supplier's country as two letters, for example PH.");
  const addressLine1 = required(body.addressLine1, 140, 'supplier_details_missing', "Enter the supplier's registered address.");
  const addressCity = required(body.addressCity, 80, 'supplier_details_missing', "Enter the supplier's city.");
  const addressPostalCode = text(body.addressPostalCode, 16);
  let email: string | null = null;
  if (body.email !== undefined && body.email !== null && body.email !== '') {
    const e = String(body.email).trim().toLowerCase();
    if (e.length > 200 || !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(e)) throw new RecipientInputError('bad_email', 'That email address does not look right.');
    email = e;
  }
  return { name, legalName, registrationNumber, country, addressLine1, addressCity, addressPostalCode, email };
}

/** A Sui address, long form. Never an EVM address padded to fit. */
export function suiRecipientAddress(value: unknown): string {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (/^0x[0-9a-fA-F]{40}$/.test(raw)) {
    throw new RecipientInputError('bad_address', 'That is an EVM address. A recipient paid on Sui needs a Sui address; for another chain, add a cross-chain recipient.');
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(raw)) throw new RecipientInputError('bad_address', 'A Sui address is 0x followed by 64 hexadecimal characters.');
  const address = normalizeSuiAddress(raw);
  if (/^0x0{64}$/.test(address)) throw new RecipientInputError('bad_address', 'The zero address cannot receive USDC.');
  return address;
}

export type ExchangeRecipientInput = { kind: 'EXCHANGE'; supplier: SupplierDetails; exchange: TravelRuleExchange; network: 'SUI'; depositAddress: string };
export type SelfCustodyRecipientInput = { kind: 'SELF_CUSTODY'; supplier: SupplierDetails; walletLabel: WalletLabel; address: string };
export type CrossChainRecipientInput = {
  kind: 'CROSS_CHAIN';
  supplier: SupplierDetails;
  chain: CrossChainChain;
  /** As the chain writes it: EVM lower-case hex, Solana base58 (the USDC token account). */
  address: string;
  /** CCTP's 32 bytes, 0x hex. */
  mintRecipient: string;
  domain: number;
};
export type WalletRecipientInput = ExchangeRecipientInput | SelfCustodyRecipientInput | CrossChainRecipientInput;

/** Refuse any asset but USDC: one payment asset (D6), and CCTP carries USDC only. */
function usdcOnly(body: Record<string, unknown>) {
  if (body.asset !== undefined && String(body.asset).trim().toUpperCase() !== 'USDC') {
    throw new RecipientInputError('usdc_only', 'Wallet recipients are paid in USDC only.');
  }
}

/** One wallet recipient from a request body, checked for its kind. */
export function parseWalletRecipient(body: Record<string, unknown>): WalletRecipientInput {
  const kind = body.deliveryKind;
  if (kind !== 'EXCHANGE' && kind !== 'SELF_CUSTODY' && kind !== 'CROSS_CHAIN') {
    throw new RecipientInputError('bad_delivery_kind', 'Choose how this recipient is paid: an exchange account, a wallet the supplier holds, or another chain.');
  }
  usdcOnly(body);
  const supplier = parseSupplierDetails(body);
  if (kind === 'EXCHANGE') {
    const exchange = String(body.exchange ?? '').trim().toLowerCase();
    if (!isTravelRuleExchange(exchange)) throw new RecipientInputError('bad_exchange', `Choose the exchange the supplier's account is at (${TRAVEL_RULE_EXCHANGES.length} are offered).`);
    const network = String(body.network ?? 'SUI').trim().toUpperCase();
    if (!(EXCHANGE_NETWORKS as readonly string[]).includes(network)) {
      throw new RecipientInputError('network_unsupported', 'Splash pays exchange accounts in USDC on Sui. Ask the supplier for their Sui deposit address at the exchange.');
    }
    return { kind, supplier, exchange, network: 'SUI', depositAddress: suiRecipientAddress(body.depositAddress) };
  }
  if (kind === 'SELF_CUSTODY') {
    const label = String(body.walletLabel ?? 'OTHER').trim().toUpperCase();
    if (!(WALLET_LABELS as readonly string[]).includes(label)) throw new RecipientInputError('bad_wallet_label', 'Choose the wallet app, or Other.');
    return { kind, supplier, walletLabel: label as WalletLabel, address: suiRecipientAddress(body.address) };
  }
  const chain = String(body.chain ?? '').trim().toUpperCase();
  if (chain === 'SUI') throw new RecipientInputError('wrong_chain', 'That recipient is on Sui. Add it as an exchange account or a wallet the supplier holds.');
  if (!isCrossChainChain(chain)) {
    throw new RecipientInputError('chain_unsupported', `Splash pays USDC over CCTP to ${Object.keys(CROSS_CHAIN_CHAINS).map((c) => FUNDING_CHAINS[c as CrossChainChain].label).join(', ')}.`);
  }
  const facts = FUNDING_CHAINS[chain];
  const raw = typeof body.address === 'string' ? body.address.trim() : '';
  try {
    if (facts.addressFormat === 'EVM') {
      const mintRecipient = evmMintRecipient(raw);
      return { kind, supplier, chain, address: raw.toLowerCase(), mintRecipient, domain: facts.cctpDomain };
    }
    // Solana: CCTP mints to a USDC token account. A wallet key looks the same
    // and loses the funds, so the business says which it gave.
    if (body.addressIsUsdcTokenAccount !== true) {
      throw new RecipientInputError(
        'solana_token_account_needed',
        "For Solana, give the supplier's USDC token account (their associated token account), not their wallet address, and confirm that is what it is.",
      );
    }
    return { kind, supplier, chain, address: raw, mintRecipient: solanaTokenAccountMintRecipient(raw), domain: facts.cctpDomain };
  } catch (error) {
    if (error instanceof FundingPlanError) throw new RecipientInputError('bad_address', error.message);
    throw error;
  }
}

/** What screening calls the recipient's kind and chain (lib/compliance/kyt.ts). */
export function screeningSubjectOf(input: WalletRecipientInput): { kind: 'exchange_recipient' | 'wallet_recipient' | 'cross_chain_recipient'; chain: string; address: string } {
  if (input.kind === 'EXCHANGE') return { kind: 'exchange_recipient', chain: 'SUI', address: input.depositAddress };
  if (input.kind === 'SELF_CUSTODY') return { kind: 'wallet_recipient', chain: 'SUI', address: input.address };
  return { kind: 'cross_chain_recipient', chain: CROSS_CHAIN_CHAINS[input.chain], address: input.address };
}

/**
 * What the Move side needs to pay a saved recipient: the intent kind, the
 * address the intent names (on Sui), the SpendPolicy tag (none for a
 * cross-chain recipient: it is never on a policy), and for CCTP the domain
 * and mint recipient `create_cross_chain_for_wallet` takes.
 */
export type MoveDelivery =
  | { kind: typeof MOVE_KIND.EXCHANGE; recipient: string; policyTag: typeof POLICY_TAG.EXCHANGE; exchange: TravelRuleExchange; ownersOnly: false }
  | { kind: typeof MOVE_KIND.WALLET; recipient: string; policyTag: typeof POLICY_TAG.WALLET; ownersOnly: false }
  | { kind: typeof MOVE_KIND.CROSS_CHAIN; destinationDomain: number; mintRecipient: string; chain: CrossChainChain; policyTag: null; ownersOnly: true };

export type StoredDelivery = {
  deliveryKind: DeliveryKind;
  walletAddress?: string | null;
  exchangeId?: string | null;
  destinationChain?: string | null;
  destinationDomain?: number | null;
  mintRecipient?: string | null;
};

export function moveDeliveryOf(r: StoredDelivery): MoveDelivery | null {
  if (r.deliveryKind === 'EXCHANGE' && r.walletAddress && isTravelRuleExchange(r.exchangeId)) {
    return { kind: MOVE_KIND.EXCHANGE, recipient: normalizeSuiAddress(r.walletAddress), policyTag: POLICY_TAG.EXCHANGE, exchange: r.exchangeId, ownersOnly: false };
  }
  if (r.deliveryKind === 'SELF_CUSTODY' && r.walletAddress) {
    return { kind: MOVE_KIND.WALLET, recipient: normalizeSuiAddress(r.walletAddress), policyTag: POLICY_TAG.WALLET, ownersOnly: false };
  }
  if (r.deliveryKind === 'CROSS_CHAIN' && isCrossChainChain(r.destinationChain) && r.mintRecipient && typeof r.destinationDomain === 'number') {
    if (FUNDING_CHAINS[r.destinationChain].cctpDomain !== r.destinationDomain) return null;
    return { kind: MOVE_KIND.CROSS_CHAIN, destinationDomain: r.destinationDomain, mintRecipient: r.mintRecipient, chain: r.destinationChain, policyTag: null, ownersOnly: true };
  }
  return null;
}

// ─── The ownership proof (D5b) ──────────────────────────────────────────────

/** How long an ownership-proof link stays open: three days, for a supplier in another time zone. */
export const OWNERSHIP_PROOF_TTL_MS = 72 * 3_600_000;

/**
 * The fixed message a self-custody supplier signs with the wallet, as a Sui
 * personal message. It names the address, the supplier's business, the
 * business that will pay it, a single-use nonce and the expiry, so a
 * signature for one address, payer or link proves nothing for another.
 */
export function ownershipProofMessage(input: { address: string; supplierName: string; payingBusiness: string; nonce: string; expiresAt: Date }): string {
  const clean = (v: string) => v.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 140);
  if (!/^[0-9a-f]{64}$/.test(input.nonce)) throw new RecipientInputError('bad_nonce', 'An ownership proof needs a 32-byte nonce.');
  return [
    'Splash wallet ownership proof',
    '',
    'I control this wallet. I ask that payments to me be sent to it.',
    '',
    `Address: ${normalizeSuiAddress(input.address)}`,
    `Business that holds this wallet: ${clean(input.supplierName)}`,
    `Business that will pay it: ${clean(input.payingBusiness)}`,
    `Nonce: ${input.nonce}`,
    `Expires: ${input.expiresAt.toISOString()}`,
    '',
    'Signing this message moves no money and gives no one access to the wallet.',
  ].join('\n');
}
