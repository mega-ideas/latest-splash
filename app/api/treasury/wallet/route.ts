import { NextResponse } from 'next/server';

import { normaliseSuiAddress, StablecoinLaneError, SUI_USDC_COIN_TYPE, STABLECOIN_NETWORK } from '@/lib/payments/stablecoin-lane';
import { USDY_COIN_TYPE_SUI } from '@/lib/payments/treasury-usdy';
import { RATE_LIMITS, enforceRateLimit } from '@/lib/server/rate-limit';
import { labelFor } from '@/lib/server/signed-partners';
import { laneClient } from '@/lib/server/stablecoin-chain';
import { treasuryFlags } from '@/lib/server/treasury-providers';
import { NO_STORE, treasuryCaller } from '@/lib/server/treasury-route';
import { listTreasuryOrders, orderView } from '@/lib/server/treasury-wallet-orders';
import { getUsdyNetApyPct, getUsdyRedemptionPrice } from '@/lib/server/usdy';

export const dynamic = 'force-dynamic';

/**
 * Treasury in the business's own wallet (v2 D9, brief 5.7). Not locked by
 * custody: USDY sits in the business wallet, and Splash holds nothing.
 *
 * GET [?address=0x…]
 *   what Treasury may do on this server (flags), who the issuer and the fund
 *   manager are called here (their names only if signed, their roles
 *   otherwise), the USDY price and the modeled rate, this org's orders, and,
 *   with `address`, that wallet's USDC and USDY from Sui. The page takes the
 *   address from the business wallet (GET /api/wallet/business); balances are
 *   public chain data, read and never stored.
 */
export async function GET(request: Request) {
  const gate = await treasuryCaller(request);
  if (gate.response) return gate.response;
  const limited = await enforceRateLimit({ rule: RATE_LIMITS.treasuryOverviewUser, key: gate.session.email });
  if (limited) return limited;

  const url = new URL(request.url);
  const asked = url.searchParams.get('address');
  let address: string | null = null;
  if (asked) {
    try {
      address = normaliseSuiAddress(asked);
    } catch (error) {
      if (error instanceof StablecoinLaneError) return NextResponse.json({ error: error.message }, { status: 400, headers: NO_STORE });
      throw error;
    }
  }

  const flags = treasuryFlags();
  const nav = await getUsdyRedemptionPrice();
  let balances: { usdcMinor: string; usdyMinor: string } | { error: string } | null = null;
  if (address) {
    try {
      const client = laneClient();
      const [usdc, usdy] = await Promise.all([
        client.core.getBalance({ owner: address, coinType: SUI_USDC_COIN_TYPE[STABLECOIN_NETWORK] }),
        client.core.getBalance({ owner: address, coinType: USDY_COIN_TYPE_SUI }),
      ]);
      balances = { usdcMinor: usdc.balance.balance, usdyMinor: usdy.balance.balance };
    } catch (error) {
      balances = { error: `Could not read the wallet from Sui: ${error instanceof Error ? error.message : 'unknown error'}` };
    }
  }

  let orders: ReturnType<typeof orderView>[] | null = null;
  if (process.env.DATABASE_URL) {
    const { getDb } = await import('@/lib/db/client');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    orders = (await listTreasuryOrders(getDb() as any, gate.caller.orgId)).map(orderView);
  }

  return NextResponse.json(
    {
      flags: { walletSwaps: flags.walletSwaps, fundReferral: flags.fundReferral, tokenizedStocks: flags.tokenizedStocks },
      issuerConfirmed: flags.issuerEligibilityConfirmed,
      issuer: labelFor('ondo'),
      fundManager: labelFor('halogen'),
      role: gate.caller.role,
      price: { status: nav.status, priceMicros: nav.priceMicros?.toString() ?? null, asOf: nav.asOf },
      apyPct: getUsdyNetApyPct(),
      address,
      balances,
      orders,
    },
    { headers: NO_STORE },
  );
}
