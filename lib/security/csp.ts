/**
 * The Content-Security-Policy, built per request around a nonce.
 *
 * Pure: no imports, so it runs in the proxy, in a test, and anywhere else
 * without dragging the app in. proxy.ts mints the nonce and sets the policy
 * on the response; Next.js reads the `'nonce-…'` from the request's
 * Content-Security-Policy header during server rendering and attaches it to
 * every script it emits, which is why every page must render dynamically
 * (app/layout.tsx).
 *
 * The line that matters is script-src: a nonce, `'strict-dynamic'` so the
 * chunks a nonced script loads are trusted transitively (Next's runtime, and
 * the Sumsub SDK the KYB page creates with `document.createElement`), and
 * never `'unsafe-inline'` — an injected inline script does not run. Styles
 * allow inline attributes because React `style={{}}` props render as inline
 * style attributes throughout the app; that is a much smaller surface than
 * scripts, and hashing every prop is not practical.
 *
 * The only third party is Sumsub, embedded for KYB: its SDK opens a frame
 * and talks to its API. Nothing else is allowed from anywhere else.
 */

export type CspOptions = {
  /** Base64 of at least 16 random bytes, fresh for this request. */
  nonce: string;
  /** Development needs `'unsafe-eval'` (React reconstructs stack traces with
   *  eval) and websockets for hot reload; production gets neither. */
  isDev?: boolean;
};

const SUMSUB = ['https://*.sumsub.com'];

const NONCE_SHAPE = /^[A-Za-z0-9+/=_-]+$/;

export function buildContentSecurityPolicy({ nonce, isDev = false }: CspOptions): string {
  if (!nonce || !NONCE_SHAPE.test(nonce)) {
    throw new Error('a Content-Security-Policy needs a fresh base64 nonce for this request');
  }

  const directives: Array<[string, string[]]> = [
    ['default-src', ["'self'"]],
    [
      'script-src',
      ["'self'", `'nonce-${nonce}'`, "'strict-dynamic'", 'https://static.sumsub.com', ...(isDev ? ["'unsafe-eval'"] : [])],
    ],
    ['style-src', ["'self'", "'unsafe-inline'"]],
    ['img-src', ["'self'", 'data:', 'blob:', ...SUMSUB]],
    ['font-src', ["'self'", 'data:']],
    ['connect-src', ["'self'", ...SUMSUB, 'wss://*.sumsub.com', ...(isDev ? ['ws:', 'wss:'] : [])]],
    ['frame-src', ["'self'", ...SUMSUB]],
    ['worker-src', ["'self'", 'blob:']],
    ['media-src', ["'self'", 'blob:']],
    ['manifest-src', ["'self'"]],
    ['object-src', ["'none'"]],
    ['base-uri', ["'self'"]],
    ['form-action', ["'self'"]],
    ['frame-ancestors', ["'none'"]],
  ];

  const parts = directives.map(([name, sources]) => `${name} ${sources.join(' ')}`);
  if (!isDev) parts.push('upgrade-insecure-requests');
  return parts.join('; ');
}
