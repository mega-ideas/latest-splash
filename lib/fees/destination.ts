/**
 * Where a payment goes, and the kind Splash's fee is charged as there
 * (Amendment A1 §2.3, §4; the A1 review).
 *
 * A quote is priced by the destination the payer chose, through the settle
 * paths' own kind rules (`settlementKind`: `address_registry::derive_kind`,
 * then `assert_kind_fits`), never by a kind typed in:
 *
 *   bank             a local-currency payout to a supplier's bank. It is paid
 *                    to the payout partner's registered deposit address, so
 *                    it is a BANK_PAYOUT.
 *   sui_wallet       a Sui address, declared WALLET;
 *   exchange         an exchange's deposit address, declared EXCHANGE;
 *   splash_business  a Splash business's wallet, declared SPLASH_BUSINESS.
 *                    For these three the address registry decides: a
 *                    registered business wallet is a free Splash-business
 *                    payment, a partner deposit address is refused (it is
 *                    only ever paid as a bank payout), and a "Splash
 *                    business" the registry does not hold is refused.
 *   cross_chain      a payment out through CCTP, a CROSS_CHAIN.
 *
 * An address is never classified without the registry's answer
 * (`RegistryClass`), and what the settle paths refuse throws here as it
 * aborts there (FeeKindMismatchError), so a quote cannot price a payment the
 * chain would refuse to settle.
 *
 * Pure and client-safe.
 */
import { FEE_KIND, settlementKind, type FeeKind } from './schedule.ts';

export type PaymentDestination =
  | { readonly type: 'bank' }
  | { readonly type: 'sui_wallet' | 'exchange' | 'splash_business'; readonly address: string }
  | { readonly type: 'cross_chain' };

export type DestinationType = PaymentDestination['type'];

/** What Splash's address registry holds for an address. */
export type RegistryClass = { readonly isBusinessWallet: boolean; readonly isPartnerAddress: boolean };

/** A local-currency payout to a supplier's bank account. */
export const BANK_DESTINATION: PaymentDestination = Object.freeze({ type: 'bank' });

const ADDRESS_TYPES = new Set<DestinationType>(['sui_wallet', 'exchange', 'splash_business']);
const SUI_ADDRESS = /^0x[0-9a-f]{64}$/;

/**
 * The kind a settle path charges a payment to `destination` as. `registry`
 * is what Splash's address registry holds for the destination's address; it
 * is required for an address destination and ignored otherwise.
 */
export function destinationKind(destination: PaymentDestination, registry?: RegistryClass): FeeKind {
  switch (destination.type) {
    case 'bank':
      return settlementKind({ declared: FEE_KIND.BANK_PAYOUT, viaCctp: false, recipientIsBusinessWallet: false, recipientIsPartnerAddress: true });
    case 'cross_chain':
      return settlementKind({ declared: FEE_KIND.CROSS_CHAIN, viaCctp: true, recipientIsBusinessWallet: false, recipientIsPartnerAddress: false });
    default: {
      if (!registry) {
        throw new RangeError(`a ${destination.type} destination is classified by Splash's address registry; pass what it holds for ${destination.address}`);
      }
      const declared = destination.type === 'sui_wallet' ? FEE_KIND.WALLET : destination.type === 'exchange' ? FEE_KIND.EXCHANGE : FEE_KIND.SPLASH_BUSINESS;
      return settlementKind({
        declared,
        viaCctp: false,
        recipientIsBusinessWallet: registry.isBusinessWallet,
        recipientIsPartnerAddress: registry.isPartnerAddress,
      });
    }
  }
}

/** A destination from a request body, normalized, or null if it is not one. */
export function parseDestination(value: unknown): PaymentDestination | null {
  if (!value || typeof value !== 'object') return null;
  const { type, address } = value as { type?: unknown; address?: unknown };
  if (type === 'bank' || type === 'cross_chain') return { type };
  if (typeof type !== 'string' || !ADDRESS_TYPES.has(type as DestinationType)) return null;
  if (typeof address !== 'string') return null;
  const normalized = address.trim().toLowerCase();
  if (!SUI_ADDRESS.test(normalized)) return null;
  return { type: type as 'sui_wallet' | 'exchange' | 'splash_business', address: normalized };
}

/** What a customer calls a destination. */
export function destinationLabel(type: DestinationType): string {
  switch (type) {
    case 'bank':
      return 'a bank account';
    case 'sui_wallet':
      return 'a Sui wallet';
    case 'exchange':
      return 'an exchange';
    case 'splash_business':
      return 'a Splash business';
    default:
      return 'another chain';
  }
}

/**
 * Where a transfer-flow payment goes, from its recipient: a recipient paid
 * on the bank rail is a bank payout. The flow has no other rail; one it
 * cannot price throws rather than be quoted as a bank.
 */
export function destinationForRecipient(recipient: { readonly rail: string }): PaymentDestination {
  if (recipient.rail === 'bank') return BANK_DESTINATION;
  throw new RangeError(`a recipient on the ${recipient.rail} rail has no destination this flow can price`);
}
