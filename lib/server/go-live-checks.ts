/**
 * Go-live checks: is this machine set up to move real money?
 *
 * The infrastructure checks in health-checks.ts answer "can Splash run".
 * These answer the setup steps a person does by hand, each of which used to
 * be invisible until a payment hit it: the fee wallet, WhatsApp delivery, the
 * passkey domain, wallet screening, and the price sources the payout gate
 * and the treasury preview read. `npm run doctor` and GET /api/health show
 * them with the rest.
 *
 * A step not done yet is 'skipped', not 'fail': it is a deliberate absence
 * until someone does it, and health stays green meanwhile. 'fail' is for
 * what is set and wrong (a rejected key, a passkey domain the browser will
 * refuse) or a source that did not answer. Every detail says what to do.
 * No secret reaches a detail: tokens are sent, never printed.
 */
import type { Check } from './health-checks.ts';
import { relyingPartyId } from '../auth/passkey.ts';
import { readUsdyOracle } from './ondo-oracle.ts';
import { getPegStatus } from './peg.ts';
import { laneClient } from './stablecoin-chain.ts';
import { anchorFeeEnabled } from '../payments/stablecoin-lane.ts';
import { navPriceUsd } from './usdy.ts';
import { screenWalletAddress } from './wallet-screening.ts';

type Fetcher = typeof fetch;

const TIMEOUT_MS = 6_000;
const SUI_ADDRESS = /^0x[0-9a-fA-F]{64}$/;
const GUIDE = 'docs/STABLECOIN-LANE.md';

const ok = (detail: string, latencyMs?: number): Check => ({ ok: true, status: 'ok', detail, ...(latencyMs === undefined ? {} : { latencyMs }) });
const skipped = (detail: string): Check => ({ ok: true, status: 'skipped', detail });
const failed = (detail: string, latencyMs?: number): Check => ({ ok: false, status: 'fail', detail, ...(latencyMs === undefined ? {} : { latencyMs }) });

const short = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;
const reason = (e: unknown) => (e instanceof Error ? e.message : String(e));
const hostOf = (url: string | undefined, fallback: string) => {
  try { return url ? new URL(url).host : fallback; } catch { return url ?? fallback; }
};

async function withTimeout<T>(label: string, run: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const started = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const value = await Promise.race([
      run(),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out after ${TIMEOUT_MS}ms`)), TIMEOUT_MS); }),
    ]);
    return { value, ms: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

/* ── The USDC lane's own node (mainnet, gRPC) ─────────────────────────── */

export async function checkLaneNode(env: NodeJS.ProcessEnv = process.env): Promise<Check> {
  const host = hostOf(env.SUI_MAINNET_RPC_URL, 'fullnode.mainnet.sui.io');
  try {
    const { value, ms } = await withTimeout('Sui mainnet', () => laneClient().core.getReferenceGasPrice());
    return ok(`mainnet via ${host}: reference gas price ${value.referenceGasPrice}`, ms);
  } catch (e) {
    return failed(`mainnet via ${host}: ${reason(e)}. USDC transfers cannot be built or sent; set SUI_MAINNET_RPC_URL to a gRPC-web node you trust.`);
  }
}

/* ── Prices ────────────────────────────────────────────────────────────── */

export async function checkPeg(env: NodeJS.ProcessEnv = process.env): Promise<Check> {
  try {
    const { value: peg, ms } = await withTimeout('DeepBook', () => getPegStatus(env));
    if (!peg.deepbook) {
      return failed(`DeepBook gave no usable stablecoin book: payouts pause (peg_unverified) until it does. See ${GUIDE}, Prices.`, ms);
    }
    const reading = `${peg.deepbook.pair} mid ${peg.deepbook.midPrice.toFixed(4)}, ${peg.deepbook.deviationBps} bps from 1`;
    return peg.pegged
      ? ok(reading, ms)
      : failed(`${reading}: past the tolerance (DEEPBOOK_PEG_TOLERANCE_BPS), so payouts are paused.`, ms);
  } catch (e) {
    return failed(`DeepBook: ${reason(e)}. Payouts pause until the peg can be read.`);
  }
}

export async function checkUsdyPrice(env: NodeJS.ProcessEnv = process.env, fetcher: Fetcher = fetch): Promise<Check> {
  if ((env.USDY_ORACLE ?? '').trim().toLowerCase() === 'off') {
    return skipped('USDY_ORACLE=off: the treasury preview uses USDY_REDEMPTION_USD instead');
  }
  const node = hostOf(env.ETHEREUM_RPC_URL, 'ethereum-rpc.publicnode.com');
  const started = Date.now();
  const reading = await readUsdyOracle(env, fetcher);
  const ms = Date.now() - started;
  if (!reading) {
    return failed(`Ondo's USDY oracle could not be read through ${node}: the treasury preview falls back to USDY_REDEMPTION_USD, or shows no price. Set ETHEREUM_RPC_URL to a working Ethereum node.`, ms);
  }
  return ok(`$${navPriceUsd(reading.priceMicros)} from Ondo's oracle via ${node}, as of ${reading.observedAt.toISOString()}`, ms);
}

/* ── The fee wallet ────────────────────────────────────────────────────── */

/** Whether an id names an existing object on mainnet. */
type ObjectProbe = (id: string) => Promise<boolean>;

const objectExistsOnMainnet: ObjectProbe = async (id) => {
  try {
    const result = await laneClient().core.getObject({ objectId: id });
    return Boolean(result?.object);
  } catch (error) {
    if (/not ?found|does not exist|deleted/i.test(reason(error))) return false;
    throw error;
  }
};

/**
 * A Sui address and an object id look the same. A coin id copied from an
 * explorer passes the format check, and USDC "sent" to it becomes owned by
 * that object, out of every wallet's reach. So the address is also checked
 * on mainnet: an existing object there is not a wallet.
 */
export async function checkFeeAddress(env: NodeJS.ProcessEnv = process.env, isObject: ObjectProbe = objectExistsOnMainnet): Promise<Check> {
  const address = (env.SPLASH_FEE_ADDRESS_MAINNET ?? '').trim();
  const anchorFeeOn = anchorFeeEnabled(env);
  if (!address) {
    // Stablecoin transfers are free; only the audit-anchor fee needs a wallet.
    return anchorFeeOn
      ? failed(`STABLECOIN_ANCHOR_FEE is on but SPLASH_FEE_ADDRESS_MAINNET is not set: USDC transfers out of Splash are closed until the fee wallet is set (${GUIDE}, Configuration).`)
      : skipped('SPLASH_FEE_ADDRESS_MAINNET not set: not needed while stablecoin transfers are free; the audit-anchor fee (off) will need it');
  }
  if (!SUI_ADDRESS.test(address)) {
    return failed('SPLASH_FEE_ADDRESS_MAINNET is not a Sui address (0x followed by 64 hex characters); an Ethereum address will not do.');
  }
  try {
    const { value: object, ms } = await withTimeout('Sui mainnet', () => isObject(address));
    if (object) {
      return failed(`SPLASH_FEE_ADDRESS_MAINNET (${short(address)}) is an object on mainnet, not a wallet: fees sent there would be owned by that object and unreachable. Copy the address from the wallet itself (Slush: Receive).`, ms);
    }
    return ok(`fee wallet ${short(address)} is a wallet address on mainnet; the audit-anchor fee is ${anchorFeeOn ? 'on and goes there' : 'off, so stablecoin transfers are free'}`, ms);
  } catch (e) {
    return failed(`could not check ${short(address)} on mainnet: ${reason(e)}`);
  }
}

/* ── WhatsApp codes (Twilio) ──────────────────────────────────────────── */

/**
 * Proves the credentials with an account lookup, which sends nothing and
 * costs nothing. The Auth Token only ever travels in the header.
 */
export async function checkTwilio(env: NodeJS.ProcessEnv = process.env, fetcher: Fetcher = fetch): Promise<Check> {
  const sid = (env.TWILIO_ACCOUNT_SID ?? '').trim();
  const token = (env.TWILIO_AUTH_TOKEN ?? '').trim();
  const from = (env.TWILIO_WHATSAPP_FROM ?? '').trim();
  const template = (env.TWILIO_WHATSAPP_CODE_CONTENT_SID ?? '').trim();
  const set = [sid, token, from].filter(Boolean).length;
  if (set === 0) {
    return skipped('Twilio not configured: approval codes are not delivered by WhatsApp (in development they go to the server log), so WhatsApp approvals cannot be switched on');
  }
  if (set < 3) {
    const missing = [['TWILIO_ACCOUNT_SID', sid], ['TWILIO_AUTH_TOKEN', token], ['TWILIO_WHATSAPP_FROM', from]].filter(([, v]) => !v).map(([k]) => k);
    return failed(`${missing.join(' and ')} not set: codes need all three.`);
  }
  try {
    const { value: response, ms } = await withTimeout('Twilio', () => fetcher(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}.json`, {
      headers: { Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString('base64')}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    }));
    if (response.status === 401 || response.status === 403 || response.status === 404) {
      return failed('Twilio rejected the Account SID and Auth Token: copy them again from the Twilio Console.', ms);
    }
    if (!response.ok) return failed(`Twilio answered HTTP ${response.status}.`, ms);
    const account = (await response.json()) as { status?: string; type?: string };
    if (account.status && account.status !== 'active') {
      return failed(`the Twilio account is ${account.status}: codes will not be sent until it is active.`, ms);
    }
    const delivery = template
      ? 'codes use the verification template, so they arrive at any time'
      : 'no TWILIO_WHATSAPP_CODE_CONTENT_SID: codes go as free text, which WhatsApp delivers only within 24 hours of the phone last messaging the sender';
    return ok(`credentials accepted (${account.type ?? 'unknown'} account); sending from ${from}; ${delivery}`, ms);
  } catch (e) {
    return failed(`Twilio did not answer: ${reason(e)}`);
  }
}

/* ── The passkey domain ───────────────────────────────────────────────── */

/**
 * A passkey only works on the domain it was made for, and its Sui address —
 * the Splash wallet — is tied to it. A mismatch means the browser refuses the
 * passkey; changing the domain later means new passkeys and new addresses.
 */
export function checkPasskeyDomain(env: NodeJS.ProcessEnv = process.env): Check {
  const rpId = relyingPartyId(env);
  const appUrl = (env.NEXT_PUBLIC_APP_URL ?? '').trim();
  let host = 'localhost';
  try { if (appUrl) host = new URL(appUrl).hostname; } catch { /* the env contract validates the URL */ }
  const production = env.NODE_ENV === 'production';
  const source = (env.PASSKEY_RP_ID ?? '').trim() ? 'PASSKEY_RP_ID' : appUrl ? 'the host of NEXT_PUBLIC_APP_URL' : 'the localhost default';

  if (production && rpId === 'localhost') {
    return failed('passkeys would be bound to localhost in production: set PASSKEY_RP_ID to your domain before anyone creates a passkey.');
  }
  if (host !== rpId && !host.endsWith(`.${rpId}`)) {
    return failed(`passkeys are bound to "${rpId}" (from ${source}) but the app runs on "${host}", where browsers refuse them. Set PASSKEY_RP_ID to ${host} or its root domain before anyone creates a passkey.`);
  }
  const advice = production && source !== 'PASSKEY_RP_ID'
    ? ' Set PASSKEY_RP_ID to your root domain so every subdomain shares the same passkeys.'
    : '';
  return ok(`passkeys are bound to ${rpId} (from ${source}); a passkey made for another domain is a different wallet address.${advice}`);
}

/* ── Wallet screening (Chainalysis) ───────────────────────────────────── */

const PROBE_ADDRESS = `0x${'0'.repeat(64)}`;

export async function checkScreening(env: NodeJS.ProcessEnv = process.env, fetcher: Fetcher = fetch): Promise<Check> {
  const apiKey = (env.CHAINALYSIS_SANCTIONS_API_KEY ?? '').trim();
  if (!apiKey) {
    return skipped("CHAINALYSIS_SANCTIONS_API_KEY not set: wallet recipients are saved unscreened and reach mainnet only with an admin's attestation");
  }
  const started = Date.now();
  const result = await screenWalletAddress(PROBE_ADDRESS, { apiKey, fetcher });
  const ms = Date.now() - started;
  if (result.verdict === 'CLEAR') return ok("key accepted by Chainalysis's sanctions API", ms);
  if (result.reference === 'chainalysis:http-401' || result.reference === 'chainalysis:http-403') {
    return failed('Chainalysis rejected CHAINALYSIS_SANCTIONS_API_KEY: new wallet recipients cannot be screened.', ms);
  }
  return failed(`sanctions screening is not working: ${result.detail}`, ms);
}
