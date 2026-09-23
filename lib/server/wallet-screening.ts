/**
 * Sanctions screening for wallet recipients.
 *
 * A wallet address is screened when it is SAVED, not when it is paid: the
 * recipient list is what Zeke and the send screen read from, so an address
 * that is on it has already been looked at. Screening again at send time
 * would be stronger and slower; the send path re-checks the stored verdict
 * and refuses a BLOCK regardless of how old it is.
 *
 * Provider: Chainalysis's free sanctions API, which answers "is this address
 * on a sanctions list?" — OFAC's SDN list among them. It is a list lookup, not
 * risk scoring: CLEAR means "not listed", and it says nothing about the
 * wallet's history. That is the floor for a real transfer, not the ceiling.
 *
 * Without a key, an address is saved unscreened. It reaches a MAINNET send
 * only if a named admin attested to knowing the recipient when saving it —
 * recorded as ATTESTED with who and when. An attestation is accountability,
 * not screening, and the send screen says so.
 */

export type WalletVerdict = 'CLEAR' | 'BLOCK' | 'ERROR' | 'ATTESTED';

export interface WalletScreening {
  verdict: WalletVerdict | null;
  reference: string | null;
  screenedAt: Date | null;
  detail: string;
}

type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

const CHAINALYSIS_URL = 'https://public.chainalysis.com/api/v1/address/';

export async function screenWalletAddress(
  address: string,
  opts: { apiKey?: string | null; fetcher?: Fetcher; now?: Date } = {},
): Promise<WalletScreening> {
  const apiKey = opts.apiKey === undefined ? process.env.CHAINALYSIS_SANCTIONS_API_KEY : opts.apiKey;
  const now = opts.now ?? new Date();
  if (!apiKey) {
    return { verdict: null, reference: null, screenedAt: null, detail: 'No screening provider is configured.' };
  }
  const fetcher = opts.fetcher ?? fetch;
  try {
    const res = await fetcher(`${CHAINALYSIS_URL}${encodeURIComponent(address)}`, {
      headers: { 'X-API-Key': apiKey, Accept: 'application/json' },
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) {
      return { verdict: 'ERROR', reference: `chainalysis:http-${res.status}`, screenedAt: now, detail: `Screening provider answered ${res.status}.` };
    }
    const body = (await res.json()) as { identifications?: Array<{ name?: string; category?: string }> };
    const hits = Array.isArray(body.identifications) ? body.identifications : [];
    if (hits.length > 0) {
      const names = hits.map((h) => h.name || h.category || 'listed').join('; ');
      return { verdict: 'BLOCK', reference: `chainalysis:sanctions:${now.toISOString()}:${names}`.slice(0, 500), screenedAt: now, detail: `Listed: ${names}` };
    }
    return { verdict: 'CLEAR', reference: `chainalysis:sanctions:${now.toISOString()}`, screenedAt: now, detail: 'Not on a sanctions list.' };
  } catch (error) {
    return {
      verdict: 'ERROR',
      reference: 'chainalysis:unreachable',
      screenedAt: now,
      detail: `Screening provider unreachable: ${error instanceof Error ? error.message : 'unknown error'}`,
    };
  }
}

/** A named admin vouching for an unscreened address. */
export function attestation(userId: string, now = new Date()): WalletScreening {
  return {
    verdict: 'ATTESTED',
    reference: `operator-attested:${userId}:${now.toISOString()}`,
    screenedAt: now,
    detail: 'Not screened — an admin attested to knowing this recipient.',
  };
}

/**
 * Whether a recipient with this stored verdict may be paid. The lane is
 * mainnet-only, so this is the mainnet rule: CLEAR, or a recorded
 * attestation. A BLOCK stops it, always.
 */
export function walletSendable(verdict: string | null | undefined): { ok: boolean; reason: string } {
  if (verdict === 'BLOCK') {
    return { ok: false, reason: 'This wallet is on a sanctions list. Splash will not send to it.' };
  }
  if (verdict === 'CLEAR' || verdict === 'ATTESTED') return { ok: true, reason: '' };
  if (verdict === 'ERROR') {
    return { ok: false, reason: 'Screening could not complete for this wallet. Re-save the recipient to screen it again.' };
  }
  return {
    ok: false,
    reason: 'This wallet has not been screened. Configure sanctions screening, or have an admin attest to the recipient when saving it.',
  };
}
