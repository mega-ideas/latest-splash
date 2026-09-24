/**
 * What the settlement PTB is allowed to write into `PegState`.
 *
 * Audit finding (high): every settlement PTB called
 *
 *     peg_monitor::update_peg(state, cap, SPLASH_PEG_USDC_DEVIATION_PPM ?? '0',
 *                                         SPLASH_PEG_USDT_DEVIATION_PPM ?? '0', clock)
 *
 * as its FIRST command, and `settle_payment` — which calls `assert_pegged` —
 * as its second. The breaker therefore read a perfect 0-ppm peg that the very
 * same transaction had just written, one instruction earlier. `assert_pegged`
 * could not fail. The on-chain peg circuit breaker, the control that exists so
 * that funds cannot leave on a broken peg even when the off-chain layer is
 * bypassed, was inert in every deployment.
 *
 * Two things were wrong and both are fixed here:
 *
 *  1. The pushed value was a CONSTANT (env, defaulting to `0`), not a
 *     measurement. A settlement may only attest a reading it actually took.
 *  2. `pythAdapter` fell back to `mockPrice()` — an exact $1.00, `source:
 *     'mock'` — on any Hermes error, so even "measured" could mean fabricated.
 *     It now reports Pyth as unavailable instead (a mock only exists when
 *     USE_MOCK_APIS asks for one), and a fabricated reading is never pushed.
 *
 * When no live reading is available the PTB simply omits `update_peg`. That is
 * the fail-closed direction: `PegState` goes stale and `assert_pegged` aborts
 * with 302 `E_PEG_STALE` rather than green-lighting a settlement against a peg
 * nobody checked.
 */
import { pythAdapter } from '@/lib/server/pyth';

export type PegAttestation =
  | { push: true; usdcDeviationPpm: number; usdtDeviationPpm: number; primary: string }
  | { push: false; reason: string };

/** ppm distance from $1.00, clamped to u64-safe non-negative integers. */
function deviationPpm(price: number): number {
  if (!Number.isFinite(price) || price <= 0) return Number.MAX_SAFE_INTEGER;
  return Math.round(Math.abs(price - 1) * 1_000_000);
}

/**
 * Measure the peg and decide whether this settlement may attest it on chain.
 *
 * Never throws: an oracle problem must not crash a settlement path, it must
 * decline to attest and let the on-chain staleness guard do its job.
 */
export async function resolvePegAttestation(env: NodeJS.ProcessEnv = process.env): Promise<PegAttestation> {
  // Demo/CI runs with USE_MOCK_APIS explicitly asked for fabricated prices, so
  // pushing them is honest there — but only there, and only because the
  // operator opted in by name.
  const mocksAllowed = env.USE_MOCK_APIS === 'true';

  let status: Awaited<ReturnType<typeof pythAdapter.getPegStatus>>;
  try {
    status = await pythAdapter.getPegStatus();
  } catch (error) {
    return { push: false, reason: `peg oracle unavailable: ${error instanceof Error ? error.message : 'unknown error'}` };
  }

  if (!status.usdcUsd || !status.usdtUsd) {
    return { push: false, reason: `no live Pyth price to attest: ${status.pyth.reason ?? 'Pyth unavailable'}` };
  }
  const fabricated = status.usdcUsd.source === 'mock' || status.usdtUsd.source === 'mock';
  if (fabricated && !mocksAllowed) {
    return {
      push: false,
      reason:
        'Pyth Hermes returned no live price and the adapter fell back to a synthetic $1.00. ' +
        'Refusing to attest a fabricated peg on chain.',
    };
  }

  const usdc = deviationPpm(status.usdcUsd.price);
  const usdt = deviationPpm(status.usdtUsd.price);

  // A broken peg is a real reading and IS pushed — that is the whole point.
  // `assert_pegged` then aborts with 300/301 against the value we just wrote,
  // which is the breaker working rather than the breaker being bypassed.
  if (!Number.isSafeInteger(usdc) || !Number.isSafeInteger(usdt)) {
    return { push: false, reason: 'peg reading is not representable as u64 ppm' };
  }

  return { push: true, usdcDeviationPpm: usdc, usdtDeviationPpm: usdt, primary: status.primary };
}
