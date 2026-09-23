import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/**
 * Fetching a URL a user pasted, from inside Splash's network.
 *
 * An x402 resource URL is user input, and the server fetches it. Unguarded,
 * that is a server-side request forgery primitive: "pay for
 * http://169.254.169.254/latest/meta-data" reads cloud credentials, and
 * "http://10.0.0.5/admin" reaches whatever sits behind the firewall. So:
 *
 *   - https only (plain http to localhost is allowed outside production, for
 *     the local demo seller);
 *   - every address the host resolves to must be public: no loopback,
 *     private, link-local, CGNAT, multicast or reserved ranges, v4 or v6;
 *   - redirects are refused, not followed — a public URL that 302s to a
 *     private one is the textbook bypass;
 *   - a timeout, and a cap on how much of the response is read.
 *
 * Residual: the check resolves the name and fetch resolves it again, so a
 * DNS answer that changes in between (rebinding) is not caught. Pinning the
 * resolved address would close it; recorded here rather than claimed.
 */

export class UnsafeUrlError extends Error {}

type Lookup = (host: string) => Promise<Array<{ address: string; family: number }>>;

const defaultLookup: Lookup = (host) => lookup(host, { all: true, verbatim: true });

function v4Private(ip: string): boolean {
  const [a, b] = ip.split('.').map(Number);
  return a === 0 || a === 10 || a === 127
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 192 && b === 0)
    || (a === 198 && (b === 18 || b === 19))
    || a >= 224;
}

function v6Private(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === '::' || lower === '::1') return true;
  const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return v4Private(mapped[1]);
  return /^(fc|fd)/.test(lower) || /^fe[89ab]/.test(lower) || /^ff/.test(lower);
}

export function isPrivateAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return v4Private(ip);
  if (family === 6) return v6Private(ip);
  return true;
}

export async function assertPublicUrl(
  raw: string,
  opts: { lookup?: Lookup; allowLocalHttp?: boolean } = {},
): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UnsafeUrlError('That is not a valid URL.');
  }
  const allowLocal = opts.allowLocalHttp ?? process.env.NODE_ENV !== 'production';
  const localHost = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (allowLocal && localHost && (url.protocol === 'http:' || url.protocol === 'https:')) return url;
  if (url.protocol !== 'https:') throw new UnsafeUrlError('Only https:// resources can be paid.');
  if (url.username || url.password) throw new UnsafeUrlError('URLs with credentials in them are refused.');

  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await (opts.lookup ?? defaultLookup)(host);
  if (addresses.length === 0) throw new UnsafeUrlError('That host does not resolve.');
  for (const { address } of addresses) {
    if (isPrivateAddress(address)) throw new UnsafeUrlError('That host points inside a private network; Splash will not fetch it.');
  }
  return url;
}

export interface SafeResponse {
  status: number;
  headers: Headers;
  body: string;
  truncated: boolean;
}

/** GET a vetted URL: no redirects, a timeout, and at most `maxBytes` read. */
export async function safeGet(
  raw: string,
  opts: { headers?: Record<string, string>; timeoutMs?: number; maxBytes?: number; lookup?: Lookup; fetcher?: typeof fetch; allowLocalHttp?: boolean } = {},
): Promise<SafeResponse> {
  const url = await assertPublicUrl(raw, opts);
  const res = await (opts.fetcher ?? fetch)(url, {
    method: 'GET',
    headers: { Accept: 'application/json, text/plain;q=0.9, */*;q=0.1', ...opts.headers },
    redirect: 'manual',
    signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
  });
  if (res.status >= 300 && res.status < 400) {
    throw new UnsafeUrlError('The resource answered with a redirect; Splash does not follow redirects when paying.');
  }
  const max = opts.maxBytes ?? 256 * 1024;
  const reader = res.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (size + value.byteLength > max) {
        chunks.push(value.slice(0, max - size));
        truncated = true;
        await reader.cancel();
        break;
      }
      chunks.push(value);
      size += value.byteLength;
    }
  }
  const body = new TextDecoder().decode(Buffer.concat(chunks.map((c) => Buffer.from(c))));
  return { status: res.status, headers: res.headers, body, truncated };
}
