/**
 * Is a Solana address a USDC token account? (v2 §4.7, D5c)
 *
 * CCTP mints to the 32-byte account it is given. On Solana that must be an
 * SPL Token account for Circle's USDC mint: a wallet key, or a token account
 * of another mint, receives nothing usable and the USDC is lost or stuck.
 * So a Solana cross-chain recipient is saved only after the chain is asked
 * (`getAccountInfo`, jsonParsed) and answers: owned by the SPL Token
 * program, of type account, for the USDC mint of this network, and
 * initialized (not frozen). The token account's owner (the supplier's
 * wallet) is recorded beside it.
 *
 * The RPC is CCTP_MINT_RPC_URLS_JSON's SOLANA entry (https only). Without
 * one nothing is saved: production and every other runtime refuse alike, so
 * there is no sandbox answer to reach. Tests pass their own fetcher.
 *
 * Mints: Circle's USDC on Solana mainnet is
 * EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v; on devnet
 * 4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU (Circle, "USDC contract
 * addresses"). The SPL Token program is
 * TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA.
 */

export const SPL_TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const SOLANA_USDC_MINT = Object.freeze({
  mainnet: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  testnet: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
});

export type SolanaTokenAccountCheck =
  | { ok: true; tokenOwner: string }
  | { ok: false; code: 'solana_not_usdc_token_account' | 'solana_check_unavailable' | 'solana_check_not_configured'; reason: string };

export interface SolanaTokenAccountReader {
  check(address: string): Promise<SolanaTokenAccountCheck>;
}

type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

function rpcUrl(env: NodeJS.ProcessEnv): string | null {
  try {
    const parsed = JSON.parse((env.CCTP_MINT_RPC_URLS_JSON ?? '').trim() || '{}') as Record<string, unknown>;
    const url = typeof parsed?.SOLANA === 'string' ? parsed.SOLANA.trim() : '';
    return /^https:\/\//.test(url) ? url : null;
  } catch {
    return null;
  }
}

/** The network's USDC mint: mainnet unless SUI_NETWORK says testnet (Splash's networks move together). */
function networkOf(env: NodeJS.ProcessEnv): 'mainnet' | 'testnet' {
  const n = (env.SUI_NETWORK ?? '').trim().toLowerCase();
  return n === 'testnet' || n === 'devnet' ? 'testnet' : 'mainnet';
}

export function solanaTokenAccountReaderFromEnv(env: NodeJS.ProcessEnv = process.env, fetcher: Fetcher = fetch): SolanaTokenAccountReader {
  const url = rpcUrl(env);
  const mint = SOLANA_USDC_MINT[networkOf(env)];
  return {
    async check(address) {
      if (!url) return { ok: false, code: 'solana_check_not_configured', reason: 'No Solana RPC is set up (CCTP_MINT_RPC_URLS_JSON, SOLANA), so the token account cannot be checked.' };
      let json: { result?: { value?: unknown } | null; error?: unknown };
      try {
        const res = await fetcher(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getAccountInfo', params: [address, { encoding: 'jsonParsed', commitment: 'finalized' }] }),
          signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) return { ok: false, code: 'solana_check_unavailable', reason: `The Solana RPC answered ${res.status}.` };
        json = (await res.json()) as typeof json;
      } catch {
        return { ok: false, code: 'solana_check_unavailable', reason: 'The Solana RPC could not be reached.' };
      }
      if (json.error || !json.result) return { ok: false, code: 'solana_check_unavailable', reason: 'The Solana RPC refused the read.' };
      return readTokenAccount(json.result.value, mint);
    },
  };
}

/** The verdict on one `getAccountInfo` jsonParsed value. */
export function readTokenAccount(value: unknown, usdcMint: string): SolanaTokenAccountCheck {
  const refuse = (reason: string): SolanaTokenAccountCheck => ({ ok: false, code: 'solana_not_usdc_token_account', reason });
  if (!value || typeof value !== 'object') return refuse('There is no account at that address on Solana.');
  const v = value as { owner?: unknown; data?: unknown };
  if (v.owner !== SPL_TOKEN_PROGRAM) return refuse('That address is not a token account (it is not owned by the SPL Token program); it may be a wallet address.');
  const parsed = (v.data as { parsed?: { type?: unknown; info?: { mint?: unknown; owner?: unknown; state?: unknown } } } | null)?.parsed;
  if (!parsed || parsed.type !== 'account' || !parsed.info) return refuse('That address is not a token account.');
  if (parsed.info.mint !== usdcMint) return refuse("That token account does not hold Circle's USDC.");
  if (parsed.info.state !== 'initialized') return refuse('That token account is frozen or not initialized.');
  if (typeof parsed.info.owner !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(parsed.info.owner)) return refuse('That token account names no owner.');
  return { ok: true, tokenOwner: parsed.info.owner };
}
