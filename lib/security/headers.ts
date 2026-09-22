/**
 * The static security headers, on every response — API routes included.
 *
 * Applied by next.config.ts `headers()`. The Content-Security-Policy is
 * deliberately not here: it carries a per-request nonce and is set by
 * proxy.ts. Pure, so a test can read the same list the config applies.
 */
export const SECURITY_HEADERS: ReadonlyArray<{ key: string; value: string }> = [
  // Two years, subdomains included, eligible for the preload list. Once a
  // browser has seen this it will not make a plain-http request to the host.
  { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' },
  // A response is what its Content-Type says, never what it looks like.
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  // Full URL to our own origin; origin only to anyone else; nothing on a
  // downgrade — a pay-link slug in a Referer would otherwise leak.
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  // The CSP says frame-ancestors 'none'; this is the same rule for browsers
  // that only read the old header. Approval screens are never framable.
  { key: 'X-Frame-Options', value: 'DENY' },
  // The KYB flow (Sumsub) needs the camera and microphone; nothing else on
  // the site needs any powerful feature, and the rest are turned off.
  {
    key: 'Permissions-Policy',
    value: 'camera=(self "https://*.sumsub.com"), microphone=(self "https://*.sumsub.com"), geolocation=(), payment=(), usb=(), interest-cohort=()',
  },
];
