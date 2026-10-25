/**
 * Which payout partner adapter this server uses (v2 §4.5): the sandbox
 * outside production, the live adapter in production, and a refusal for a
 * route switched off or not built yet. `isProductionRuntime` alone decides:
 * USE_MOCK_APIS or a demo flag never brings a sandbox into production.
 */

import { isProductionRuntime } from '../server/runtime-mode.ts';
import { hataFiuuAdapter } from './hata-fiuu.ts';
import { PayoutPartnerUnavailable, type PayoutPartner, type PayoutPartnerId } from './partner.ts';

const ENABLED_FLAG: Record<PayoutPartnerId, { key: string; fallback: boolean }> = {
  hata_fiuu: { key: 'PAYOUT_PARTNER_HATA_FIUU_ENABLED', fallback: true },
  pdax: { key: 'PAYOUT_PARTNER_PDAX_ENABLED', fallback: true },
  durianpay: { key: 'PAYOUT_PARTNER_DURIANPAY_ENABLED', fallback: true },
  cctp_wallet: { key: 'PAYOUT_PARTNER_CCTP_WALLET_ENABLED', fallback: true },
};

export function payoutPartnerEnabled(id: PayoutPartnerId, env: NodeJS.ProcessEnv = process.env): boolean {
  const { key, fallback } = ENABLED_FLAG[id];
  const v = (env[key] ?? '').trim().toLowerCase();
  return v === '' ? fallback : v === 'true';
}

export function payoutPartner(id: PayoutPartnerId, env: NodeJS.ProcessEnv = process.env): PayoutPartner {
  if (!payoutPartnerEnabled(id, env)) throw new PayoutPartnerUnavailable('This payout route is switched off on this server.', 'partner_disabled');
  const production = isProductionRuntime(env);
  switch (id) {
    case 'hata_fiuu':
      return hataFiuuAdapter(production, env);
    default:
      // §4.5 moves pdax, durianpay and cctp_wallet onto this interface.
      throw new PayoutPartnerUnavailable('This payout route is not on the payout interface yet.', 'partner_not_built');
  }
}
