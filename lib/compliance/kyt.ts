/**
 * Transaction screening (KYT) behind one interface (v2 §4.3, §4.6, D8).
 *
 * What is screened: money arriving in a business wallet (the sender, with the
 * transaction), and every address a business pays — a self-custody wallet, an
 * exchange deposit address, a cross-chain USDC recipient. Providers:
 *
 *   elliptic               the contracted provider (D8): Elliptic's AML API,
 *                          wallet exposure, synchronous. Its risk score
 *                          decides (thresholds below).
 *   chainalysis_sanctions  the free sanctions list, the fallback until
 *                          Elliptic is contracted. A list lookup: CLEAR means
 *                          "not listed", not "low risk".
 *   sandbox                outside production only, deterministic, labelled.
 *   none                   production with nothing configured: no verdict.
 *
 * No verdict is ever asserted without a provider's answer. `verdict: null`
 * means unscreened: a timeout, an error, an answer without the provider's own
 * reference, a chain the provider was not asked about, or no provider at all.
 * Whatever reads a screening holds or refuses on null; nothing here turns
 * null into CLEAR.
 */

import { createHmac } from 'node:crypto';

import { isProductionRuntime } from '../server/runtime-mode.ts';
import { screenWalletAddress } from '../server/wallet-screening.ts';

export type KytVerdict = 'CLEAR' | 'BLOCK' | 'REVIEW';
export type KytProviderId = 'elliptic' | 'chainalysis_sanctions' | 'sandbox' | 'none';

export type KytScreening = {
  provider: KytProviderId;
  verdict: KytVerdict | null;
  /** The provider's reference for the answer; null when there was none. */
  reference: string | null;
  detail: string;
  screenedAt: string | null;
  /** Elliptic's risk score (0 to 10) when it gave one. */
  riskScore?: number | null;
};

export type KytSubject = {
  /** 'SUI', 'SOLANA', or an EVM chain name. */
  chain: string;
  address: string;
  direction: 'deposit' | 'recipient';
  txRef?: string;
};

export interface KytProvider {
  id: KytProviderId;
  /** True only for the labelled sandbox, which never runs in production. */
  sandbox?: boolean;
  screen(subject: KytSubject): Promise<KytScreening>;
}

type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

// ─── What is screened: the subject kinds and the address formats ────────────

/** What a stored screening was about (lib/server/kyt-screenings.ts). */
export const SCREENING_KINDS = ['deposit', 'wallet_recipient', 'exchange_recipient', 'cross_chain_recipient'] as const;
export type ScreeningKind = (typeof SCREENING_KINDS)[number];
export const isScreeningKind = (v: unknown): v is ScreeningKind => typeof v === 'string' && (SCREENING_KINDS as readonly string[]).includes(v);

/** The chains a recipient may be on: Sui itself, and CCTP V2's USDC chains (D5c). */
export const EVM_CHAINS = ['ETHEREUM', 'BASE', 'ARBITRUM', 'OPTIMISM', 'POLYGON', 'AVALANCHE'] as const;
export const SCREENING_CHAINS = ['SUI', 'SOLANA', ...EVM_CHAINS] as const;
export type ScreeningChain = (typeof SCREENING_CHAINS)[number];

export class ScreeningSubjectError extends Error {
  readonly code: 'unsupported_chain' | 'bad_address' | 'wrong_chain_for_kind';
  constructor(code: ScreeningSubjectError['code'], message: string) {
    super(message);
    this.name = 'ScreeningSubjectError';
    this.code = code;
  }
}

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]+$/;

/**
 * One address, checked against its chain's format and put in the one form
 * Splash stores: a Sui address as 0x + 64 lower-case hex, an EVM address as
 * 0x + 40 lower-case hex, a Solana address as given (base58 is
 * case-sensitive). A wrong format is refused, never screened: a provider's
 * "not listed" for a mistyped address is a CLEAR about nobody.
 */
export function normalizeScreeningSubject(chainInput: unknown, addressInput: unknown, kind?: ScreeningKind): { chain: ScreeningChain; address: string } {
  const chain = typeof chainInput === 'string' ? chainInput.trim().toUpperCase() : '';
  const raw = typeof addressInput === 'string' ? addressInput.trim() : '';
  if (!(SCREENING_CHAINS as readonly string[]).includes(chain)) {
    throw new ScreeningSubjectError('unsupported_chain', `Splash screens addresses on ${SCREENING_CHAINS.join(', ')}.`);
  }
  if (kind === 'cross_chain_recipient' && chain === 'SUI') {
    throw new ScreeningSubjectError('wrong_chain_for_kind', 'A cross-chain recipient is on another chain than Sui.');
  }
  if ((kind === 'wallet_recipient' || kind === 'exchange_recipient') && chain !== 'SUI') {
    throw new ScreeningSubjectError('wrong_chain_for_kind', 'A wallet or exchange recipient on another chain is a cross-chain recipient.');
  }
  if (chain === 'SUI') {
    if (!/^0x[0-9a-fA-F]{1,64}$/.test(raw)) throw new ScreeningSubjectError('bad_address', 'A Sui address is 0x followed by up to 64 hex characters.');
    return { chain, address: `0x${raw.slice(2).toLowerCase().padStart(64, '0')}` };
  }
  if (chain === 'SOLANA') {
    if (raw.length < 32 || raw.length > 44 || !BASE58.test(raw)) throw new ScreeningSubjectError('bad_address', 'A Solana address is 32 to 44 base58 characters.');
    return { chain, address: raw };
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(raw)) throw new ScreeningSubjectError('bad_address', `An address on ${chain} is 0x followed by 40 hex characters.`);
  return { chain: chain as ScreeningChain, address: raw.toLowerCase() };
}

/** A payment to this screening may go ahead: CLEAR only. REVIEW waits for a person; null is unscreened. */
export function screeningPermitsPayment(s: Pick<KytScreening, 'verdict'> | null | undefined): boolean {
  return s?.verdict === 'CLEAR';
}

// ─── Elliptic ────────────────────────────────────────────────────────────────

/**
 * Splash's starting thresholds on Elliptic's 0 to 10 risk score, until
 * compliance sets them at contract (ELLIPTIC_REVIEW_SCORE,
 * ELLIPTIC_BLOCK_SCORE): at or above BLOCK the address is refused, at or
 * above REVIEW a person looks first, below it the address is clear.
 */
export const ELLIPTIC_DEFAULT_REVIEW_SCORE = 3;
export const ELLIPTIC_DEFAULT_BLOCK_SCORE = 7;
export const ELLIPTIC_DEFAULT_BASE_URL = 'https://aml-api.elliptic.co';
const ELLIPTIC_WALLET_PATH = '/v2/wallet/synchronous';

/**
 * Elliptic's request signature: HMAC-SHA256, keyed by the base64-decoded
 * secret, over timestamp (ms) + method + lower-cased path + body, in base64.
 */
export function ellipticSignature(secretBase64: string, timestampMs: string, method: string, path: string, body: string): string {
  return createHmac('sha256', Buffer.from(secretBase64, 'base64')).update(`${timestampMs}${method.toUpperCase()}${path.toLowerCase()}${body}`).digest('base64');
}

export type EllipticConfig = { apiKey: string; apiSecret: string; baseUrl: string; reviewScore: number; blockScore: number };

function scoreSetting(raw: string | undefined, fallback: number): number | null {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 && n <= 10 ? n : null;
}

/** Elliptic's settings, or why they cannot be used. Nothing is guessed. */
export function ellipticConfig(env: NodeJS.ProcessEnv): { ok: true; config: EllipticConfig } | { ok: false; reason: string } | null {
  const apiKey = (env.ELLIPTIC_API_KEY ?? '').trim();
  const apiSecret = (env.ELLIPTIC_API_SECRET ?? '').trim();
  if (!apiKey && !apiSecret) return null;
  if (!apiKey || !apiSecret) return { ok: false, reason: 'Elliptic needs both its API key and its secret.' };
  // Elliptic issues the secret base64-encoded; a value that decodes to fewer
  // than 16 bytes is not one of its secrets, and every request would be refused.
  if (!/^[A-Za-z0-9+/=_-]+$/.test(apiSecret) || Buffer.from(apiSecret, 'base64').length < 16) {
    return { ok: false, reason: 'The Elliptic secret is not a base64 secret Elliptic issues.' };
  }
  const reviewScore = scoreSetting(env.ELLIPTIC_REVIEW_SCORE, ELLIPTIC_DEFAULT_REVIEW_SCORE);
  const blockScore = scoreSetting(env.ELLIPTIC_BLOCK_SCORE, ELLIPTIC_DEFAULT_BLOCK_SCORE);
  if (reviewScore === null || blockScore === null || reviewScore > blockScore) {
    return { ok: false, reason: 'The Elliptic thresholds must be numbers from 0 to 10, review no higher than block.' };
  }
  return { ok: true, config: { apiKey, apiSecret, baseUrl: (env.ELLIPTIC_BASE_URL ?? '').trim() || ELLIPTIC_DEFAULT_BASE_URL, reviewScore, blockScore } };
}

function unanswered(provider: KytProviderId, detail: string): KytScreening {
  return { provider, verdict: null, reference: null, detail, screenedAt: null };
}

/** Elliptic configured in a way that cannot work: it says so instead of answering. */
function ellipticMisconfigured(reason: string): KytProvider {
  return { id: 'elliptic', async screen() { return unanswered('elliptic', `${reason} This was not screened.`); } };
}

/**
 * Elliptic's wallet exposure, synchronous. The verdict comes only from its
 * answer: an answer without its own id, or without a numeric score, is not
 * one. A null score (Elliptic holds no exposure for the address) is REVIEW,
 * not CLEAR: a fresh address is exactly what an unknown payee looks like.
 */
export function ellipticProvider(config: EllipticConfig, deps: { fetcher?: Fetcher; now?: () => Date } = {}): KytProvider {
  const fetcher = deps.fetcher ?? fetch;
  return {
    id: 'elliptic',
    async screen(subject) {
      const now = deps.now?.() ?? new Date();
      const body = JSON.stringify({
        subject: { asset: 'holistic', blockchain: 'holistic', type: 'address', hash: subject.address },
        type: 'wallet_exposure',
        customer_reference: subject.txRef ? `${subject.direction}:${subject.txRef}`.slice(0, 120) : subject.direction,
      });
      const ts = String(now.getTime());
      let res: Response;
      try {
        res = await fetcher(`${config.baseUrl}${ELLIPTIC_WALLET_PATH}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-access-key': config.apiKey,
            'x-access-sign': ellipticSignature(config.apiSecret, ts, 'POST', ELLIPTIC_WALLET_PATH, body),
            'x-access-timestamp': ts,
          },
          body,
          signal: AbortSignal.timeout(10_000),
        });
      } catch {
        return unanswered('elliptic', 'Elliptic could not be reached, so this was not screened.');
      }
      if (!res.ok) return unanswered('elliptic', `Elliptic answered ${res.status}, so this was not screened.`);
      let answer: { id?: unknown; risk_score?: unknown; error?: unknown };
      try {
        answer = (await res.json()) as typeof answer;
      } catch {
        return unanswered('elliptic', 'Elliptic sent an answer Splash could not read, so this was not screened.');
      }
      const id = typeof answer.id === 'string' && /^[A-Za-z0-9-]{6,80}$/.test(answer.id) ? answer.id : null;
      if (!id || answer.error) return unanswered('elliptic', 'Elliptic did not complete the analysis, so this was not screened.');
      const at = now.toISOString();
      if (answer.risk_score === null || answer.risk_score === undefined) {
        return { provider: 'elliptic', verdict: 'REVIEW', reference: `elliptic:${id}`, detail: 'Elliptic holds no risk score for this address. A person reviews it first.', screenedAt: at, riskScore: null };
      }
      const score = typeof answer.risk_score === 'number' && Number.isFinite(answer.risk_score) ? answer.risk_score : null;
      if (score === null || score < 0 || score > 10) return unanswered('elliptic', 'Elliptic sent a risk score Splash could not read, so this was not screened.');
      const verdict: KytVerdict = score >= config.blockScore ? 'BLOCK' : score >= config.reviewScore ? 'REVIEW' : 'CLEAR';
      const detail = verdict === 'BLOCK' ? `Elliptic risk score ${score}: refused.` : verdict === 'REVIEW' ? `Elliptic risk score ${score}: a person reviews it first.` : `Elliptic risk score ${score}.`;
      return { provider: 'elliptic', verdict, reference: `elliptic:${id}`, detail, screenedAt: at, riskScore: score };
    },
  };
}

// ─── Chainalysis sanctions list, sandbox, none ───────────────────────────────

function chainalysisSanctions(apiKey: string, fetcher?: Fetcher, now?: () => Date): KytProvider {
  return {
    id: 'chainalysis_sanctions',
    async screen(subject) {
      const result = await screenWalletAddress(subject.address, { apiKey, fetcher, now: now?.() });
      const verdict = result.verdict === 'CLEAR' ? 'CLEAR' : result.verdict === 'BLOCK' ? 'BLOCK' : null;
      return {
        provider: 'chainalysis_sanctions',
        verdict,
        reference: verdict ? result.reference : null,
        detail: result.detail,
        screenedAt: verdict && result.screenedAt ? result.screenedAt.toISOString() : null,
      };
    },
  };
}

/**
 * The sandbox: an address ending in `dead` is a sanctions hit, one ending in
 * `beef` needs review, anything else is clear. Never in production.
 */
function sandbox(now?: () => Date): KytProvider {
  return {
    id: 'sandbox',
    sandbox: true,
    async screen(subject) {
      const a = subject.address.toLowerCase();
      const verdict: KytVerdict = a.endsWith('dead') ? 'BLOCK' : a.endsWith('beef') ? 'REVIEW' : 'CLEAR';
      const at = (now?.() ?? new Date()).toISOString();
      return { provider: 'sandbox', verdict, reference: `sandbox:${verdict.toLowerCase()}:${a.slice(-8)}:${at}`, detail: 'Sandbox screening: not a real provider.', screenedAt: at };
    },
  };
}

function none(): KytProvider {
  return { id: 'none', async screen() { return unanswered('none', 'No screening provider is configured on this server.'); } };
}

/**
 * Elliptic decides, and Chainalysis's sanctions list can only make it
 * stricter: a listed address is BLOCK whatever Elliptic says, and anything
 * else is Elliptic's verdict. A sanctions-list CLEAR ("not listed") is never
 * taken for the contracted provider's answer.
 */
function ellipticWithSanctionsList(elliptic: KytProvider, list: KytProvider): KytProvider {
  return {
    id: 'elliptic',
    async screen(subject) {
      const listed = await list.screen(subject);
      if (listed.verdict === 'BLOCK') return listed;
      const answer = await elliptic.screen(subject);
      return { ...answer, detail: `${answer.detail} Sanctions list: ${listed.verdict ?? 'no answer'}.` };
    },
  };
}

/**
 * The provider this server screens with. Elliptic, the contracted provider
 * (D8), decides when it is configured; with Chainalysis's sanctions list also
 * configured, a listing still blocks. Chainalysis alone is the fallback until
 * Elliptic is contracted. With neither, production answers no verdict and
 * development uses the sandbox. `USE_MOCK_APIS` never brings the sandbox into
 * production: only the runtime mode decides.
 */
export function kytProviderFromEnv(env: NodeJS.ProcessEnv = process.env, deps: { fetcher?: Fetcher; now?: () => Date } = {}): KytProvider {
  const e = ellipticConfig(env);
  const elliptic = e === null ? null : e.ok ? ellipticProvider(e.config, deps) : ellipticMisconfigured(e.reason);
  const chainalysis = (env.CHAINALYSIS_SANCTIONS_API_KEY ?? '').trim();
  if (elliptic && chainalysis) return ellipticWithSanctionsList(elliptic, chainalysisSanctions(chainalysis, deps.fetcher, deps.now));
  if (elliptic) return elliptic;
  if (chainalysis) return chainalysisSanctions(chainalysis, deps.fetcher, deps.now);
  return isProductionRuntime(env) ? none() : sandbox(deps.now);
}
