import { SuiGrpcClient } from '@mysten/sui/grpc';

import { resolveNetwork, type SuiNetwork } from '@/lib/network';

export type { SuiNetwork };

// One source of truth for the network (lib/network.ts); the RPC client and
// every label derive from the same answer.
export const SUI_NETWORK: SuiNetwork = resolveNetwork();
// gRPC and the retired JSON-RPC share the same fullnode URLs, so an existing
// SUI_RPC_URL override keeps working as the gRPC base URL.
export const SUI_RPC_URL = process.env.SUI_RPC_URL ?? `https://fullnode.${SUI_NETWORK}.sui.io:443`;
export const SPLASH_PACKAGE_ID = process.env.SPLASH_PACKAGE_ID ?? '';
export const SPLASH_TREASURY_ID = process.env.SPLASH_TREASURY_ID ?? '';
export const USDC_TYPE = process.env.USDC_TYPE ?? '0x2::sui::SUI';
export const USDT_TYPE = process.env.USDT_TYPE ?? '';
export const USDT_BUFFER_ID = process.env.USDT_BUFFER_ID ?? '';
export const MIN_USDC_FLOAT_MICRO = Number.parseInt(process.env.MIN_USDC_FLOAT_MICRO ?? '0', 10);
export const TREASURY_ADDRESS = process.env.TREASURY_ADDRESS ?? '';
export const ENOKI_API_KEY = process.env.ENOKI_API_KEY ?? '';
export const OPERATOR_SUI_ADDRESS = process.env.OPERATOR_SUI_ADDRESS ?? '';

export const isUsdtConfigured = () => Boolean(USDT_TYPE && USDT_BUFFER_ID);

export const suiClient = new SuiGrpcClient({
  network: SUI_NETWORK,
  baseUrl: SUI_RPC_URL,
});

export const formatSui = (amount: bigint | string | number, decimals = 6) => {
  const n = typeof amount === 'bigint' ? amount : BigInt(amount);
  const d = BigInt(10 ** decimals);
  const whole = n / d;
  const frac = n % d;

  return `${whole}.${frac.toString().padStart(decimals, '0').slice(0, 2)}`;
};

export const toBaseUnits = (human: string | number, decimals = 6): bigint => {
  const [whole, frac = ''] = String(human || '0').split('.');
  const padded = (frac + '0'.repeat(decimals)).slice(0, decimals);

  return BigInt(whole || '0') * BigInt(10 ** decimals) + BigInt(padded || '0');
};
