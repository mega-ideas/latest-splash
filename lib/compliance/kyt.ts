/**
 * Transaction screening (KYT) behind one interface (v2 §4.6, D8).
 *
 * This is the minimal interface §4.3's deposit screening needs; §4.6 extends
 * it (recipient and cross-chain screening, the evidence export). Providers:
 *
 *   elliptic               the contracted provider (D8). Its API is not wired
 *                          yet: configured, it answers no verdict, never a
 *                          made-up one.
 *   chainalysis_sanctions  the free sanctions list, the fallback until
 *                          Elliptic is contracted. A list lookup: CLEAR means
 *                          "not listed", not "low risk".
 *   sandbox                outside production only, deterministic, labelled.
 *   none                   production with nothing configured: no verdict.
 *
 * No verdict is ever asserted without a provider's answer. `verdict: null`
 * means unscreened, and a deposit without a verdict is held.
 */

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
  screen(subject: KytSubject): Promise<KytScreening>;
}

type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

/** Elliptic, configured but not wired: it says so instead of answering. */
function ellipticNotConnected(): KytProvider {
  return {
    id: 'elliptic',
    async screen() {
      return { provider: 'elliptic', verdict: null, reference: null, detail: 'Elliptic is configured but not connected yet, so this was not screened.', screenedAt: null };
    },
  };
}

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
    async screen(subject) {
      const a = subject.address.toLowerCase();
      const verdict: KytVerdict = a.endsWith('dead') ? 'BLOCK' : a.endsWith('beef') ? 'REVIEW' : 'CLEAR';
      const at = (now?.() ?? new Date()).toISOString();
      return { provider: 'sandbox', verdict, reference: `sandbox:${verdict.toLowerCase()}:${at}`, detail: 'Sandbox screening: not a real provider.', screenedAt: at };
    },
  };
}

function none(): KytProvider {
  return {
    id: 'none',
    async screen() {
      return { provider: 'none', verdict: null, reference: null, detail: 'No screening provider is configured on this server.', screenedAt: null };
    },
  };
}

/**
 * The provider this server screens with. Chainalysis's sanctions list is the
 * fallback while Elliptic is not connected; with neither, production answers
 * no verdict and development uses the sandbox.
 */
export function kytProviderFromEnv(env: NodeJS.ProcessEnv = process.env, deps: { fetcher?: Fetcher; now?: () => Date } = {}): KytProvider {
  const elliptic = Boolean((env.ELLIPTIC_API_KEY ?? '').trim() && (env.ELLIPTIC_API_SECRET ?? '').trim());
  const chainalysis = (env.CHAINALYSIS_SANCTIONS_API_KEY ?? '').trim();
  if (chainalysis) return chainalysisSanctions(chainalysis, deps.fetcher, deps.now);
  if (elliptic) return ellipticNotConnected();
  return isProductionRuntime(env) ? none() : sandbox(deps.now);
}
