import { PayoutPartnerNotConfiguredError, type PayoutPartnerAdapter } from '@/lib/server/pdax';

/**
 * The Indonesia payout partner (v2 brief D4: stablecoin to IDR to a bank),
 * behind the same adapter interface as the Philippines partner.
 *
 * Until its API is wired, the live adapter refuses: a production quote for
 * IDR shows no rate and no partner fee rather than a made-up one. The sandbox
 * adapter answers only where lib/server/pdax.ts's does, under USE_MOCK_APIS or
 * without a key, and every surface that shows its rate labels it a sandbox
 * rate (lib/server/landing-quote.ts).
 */
export const mockDurianpayAdapter: PayoutPartnerAdapter = {
  async quote(currency) {
    return { fxRate: currency === 'IDR' ? String(process.env.IDR_PER_USDC ?? '16250') : '1', partnerFeeBps: 20 };
  },
  async payout() {
    throw new PayoutPartnerNotConfiguredError('The Indonesia sandbox partner does not pay out.');
  },
};

export const liveDurianpayAdapter: PayoutPartnerAdapter = {
  async quote() {
    throw new PayoutPartnerNotConfiguredError('Live Indonesia payout quotes are not configured.');
  },
  async payout() {
    throw new PayoutPartnerNotConfiguredError('Live Indonesia payouts are not configured.');
  },
};

export const durianpayAdapter =
  process.env.USE_MOCK_APIS === 'true' || !process.env.DURIANPAY_API_KEY ? mockDurianpayAdapter : liveDurianpayAdapter;
