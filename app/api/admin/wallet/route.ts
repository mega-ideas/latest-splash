import { NextResponse } from 'next/server';

import { getAdminSession } from '@/lib/server/admin-auth';
import { getOperatorWalletInfo } from '@/lib/server/sui-settlement';
import { explorerAccountUrl, resolveNetwork } from '@/lib/network';

export const dynamic = 'force-dynamic';

export async function GET() {
  const session = await getAdminSession();

  if (!session) {
    return NextResponse.json({ error: 'Staff authentication required' }, { status: 401 });
  }

  try {
    const wallet = await getOperatorWalletInfo();
    const network = resolveNetwork();
    const faucetUrl =
      network === 'testnet'
        ? `https://faucet.testnet.sui.io/?address=${wallet.address}`
        : null;

    return NextResponse.json({
      address: wallet.address,
      totalSui: wallet.totalSui,
      totalMist: wallet.totalMist,
      coinCount: wallet.coinCount,
      network,
      faucetUrl,
      suiVisionUrl: explorerAccountUrl(wallet.address),
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Could not read operator wallet' },
      { status: 500 },
    );
  }
}
