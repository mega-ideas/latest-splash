/**
 * The custodial Smart Treasury ledger is retired (v2 D9; the 5.7 review).
 *
 * Treasury is USDY in the business's own Splash Wallet, swapped there and
 * signed by its owners (app/api/treasury/wallet). The earlier ledger moved a
 * business's USDC into a position Splash held, and it came back to life
 * whenever the custody phase was on (`custodyPhaseEnabled()`, a custody
 * package id on testnet): /api/treasury accepted moves, Zeke drafted
 * allocations, and an approval replayed them. Turning the custody phase on
 * for any other reason would have reopened a path D9 closed.
 *
 * So the ledger has its own switch, and it is a constant: off, with no
 * environment variable that turns it on. Reopening it is a code change that
 * `npm run check:treasury-wallet` refuses (scripts/check-treasury-wallet.mjs).
 * The route's ledger code is left in place behind this switch, unreachable,
 * until it is deleted together with the tests that pin it.
 */
export const CUSTODIAL_TREASURY_LEDGER_ON = false as boolean;

export const CUSTODIAL_TREASURY_RETIRED_REASON =
  "Treasury is USDY held in your business's own Splash Wallet, so Splash holds nothing for you. Get a quote on the Treasury page.";

/** What /api/treasury answers: gone, and where Treasury is now. */
export function custodialTreasuryRetiredResponse(): Response {
  return Response.json(
    { error: CUSTODIAL_TREASURY_RETIRED_REASON, code: 'treasury_in_business_wallet', moved: '/api/treasury/wallet' },
    { status: 410, headers: { 'Cache-Control': 'no-store' } },
  );
}
