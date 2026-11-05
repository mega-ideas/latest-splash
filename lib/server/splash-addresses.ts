/**
 * The addresses Splash itself controls, which must never be a recipient
 * (review B1: Splash never receives client money). Withdrawals refuse them
 * as deposit addresses (lib/server/withdrawals.ts); wallet recipients refuse
 * them at saving and at every payment gate (lib/server/wallet-recipients.ts).
 *
 *   Sui         the operator (OPERATOR_SUI_ADDRESS, which is also the gas
 *               sponsor: WALLET_GAS_SPONSOR=operator is the only sponsor),
 *               the treasury, the test recipient, and FeeConfig's fee
 *               recipient and pending recipient, read live (a recipient
 *               change has 24h notice, and the pending one is refused too).
 *   Elsewhere   the CCTP deposit addresses the operator chose
 *               (FUNDING_CCTP_DEPOSIT_ADDRESSES_JSON), for cross-chain
 *               recipients.
 *
 * Production refuses when it cannot name the fee recipient: no
 * SPLASH_FEE_CONFIG_ID, or a FeeConfig that could not be read, throws, and
 * the caller refuses rather than lets a payment through. Outside production
 * a FeeConfig that is not configured is skipped.
 */
import { splashControlledAddresses } from '../payouts/withdrawal-rules.ts';
import { isProductionRuntime } from './runtime-mode.ts';

export type SplashAddressSource = () => Promise<string[]>;

type FeeRecipients = { feeRecipient: string | null; pendingRecipient: { recipient: string } | null };

export class SplashAddressesUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SplashAddressesUnavailable';
  }
}

async function liveFeeRecipients(): Promise<FeeRecipients> {
  const { getFeeConfig } = await import('../fees/fee-config.ts');
  const cfg = await getFeeConfig();
  return { feeRecipient: cfg.feeRecipient ?? null, pendingRecipient: cfg.pendingRecipient ?? null };
}

/** Splash's Sui addresses from this server's configuration, read on each call. */
export function splashAddressSourceFromEnv(env: NodeJS.ProcessEnv = process.env, readFeeConfig: () => Promise<FeeRecipients> = liveFeeRecipients): SplashAddressSource {
  return async () => {
    const production = isProductionRuntime(env);
    if (production && (env.WALLET_GAS_SPONSOR ?? '').trim() === 'operator' && !(env.OPERATOR_SUI_ADDRESS ?? '').trim()) {
      throw new SplashAddressesUnavailable('the gas sponsor is the operator, and OPERATOR_SUI_ADDRESS is not set');
    }
    let feeConfig: FeeRecipients = { feeRecipient: null, pendingRecipient: null };
    if ((env.SPLASH_FEE_CONFIG_ID ?? '').trim()) {
      feeConfig = await readFeeConfig();
    } else if (production) {
      throw new SplashAddressesUnavailable("SPLASH_FEE_CONFIG_ID is not set, so Splash's fee recipient cannot be named");
    }
    return splashControlledAddresses({ env, feeConfig });
  };
}

/**
 * Splash's CCTP deposit addresses on other chains, lower-case (EVM) or as
 * given (Solana). Fails closed like the Sui list: a value that cannot be
 * parsed throws, and with `requireConfigured` (a cross-chain recipient being
 * saved or paid) so does production with none set, since an empty list then
 * means "unknown", not "none".
 */
export function splashCrossChainAddresses(env: NodeJS.ProcessEnv = process.env, opts: { requireConfigured?: boolean } = {}): string[] {
  const raw = (env.FUNDING_CCTP_DEPOSIT_ADDRESSES_JSON ?? '').trim();
  if (!raw) {
    if (opts.requireConfigured && isProductionRuntime(env)) {
      throw new SplashAddressesUnavailable("FUNDING_CCTP_DEPOSIT_ADDRESSES_JSON is not set, so Splash's addresses on other chains cannot be named");
    }
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new SplashAddressesUnavailable("FUNDING_CCTP_DEPOSIT_ADDRESSES_JSON could not be read, so Splash's addresses on other chains cannot be named");
  }
  const out = new Set<string>();
  const visit = (v: unknown) => {
    if (typeof v === 'string') {
      const s = v.trim();
      if (/^0x[0-9a-fA-F]{40}$/.test(s)) out.add(s.toLowerCase());
      else if (s) out.add(s);
    } else if (Array.isArray(v)) v.forEach(visit);
    else if (v && typeof v === 'object') Object.values(v).forEach(visit);
  };
  visit(parsed);
  return [...out];
}
