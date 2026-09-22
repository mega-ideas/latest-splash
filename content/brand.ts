/**
 * Brand as configuration.
 *
 * One module for the name, the domain and the support address, so a rename
 * is a config change rather than a hunt through seven files. Two things are
 * deliberate:
 *
 * - `legalEntity` is `null`. No company is incorporated yet, and "Splash
 *   Financial Labuan Ltd." — which used to sit in the footer and the
 *   Organization JSON-LD — is both an entity that does not exist and the
 *   name of the trademark holder blocking the mark. Nothing renders an
 *   entity until one exists; set this when it does.
 * - The support address literal lives here and nowhere else.
 *   tests/landing-and-numbers.test.mjs fails the build if it reappears.
 *
 * Flagged to Sky before launch: the brand name itself, the domain the site
 * is served from, and the support mailbox are all decisions this file only
 * records.
 */

const DEFAULT_SITE_URL = 'https://splash.finance';
const DEFAULT_SUPPORT_EMAIL = 'support@splash.finance';

function siteUrl(): string {
  const configured = (process.env.NEXT_PUBLIC_APP_URL ?? '').trim();
  if (!configured || configured.startsWith('http://localhost')) return DEFAULT_SITE_URL;
  return configured.replace(/\/+$/, '');
}

function supportEmail(): string {
  return (process.env.NEXT_PUBLIC_SUPPORT_EMAIL ?? '').trim() || DEFAULT_SUPPORT_EMAIL;
}

const name = 'Splash';

export const BRAND = {
  name,
  /** No legal entity is named anywhere until one is incorporated. */
  legalEntity: null as string | null,
  siteUrl: siteUrl(),
  domain: new URL(siteUrl()).host,
  supportEmail: supportEmail(),
  /** The footer line. Never carries an entity while `legalEntity` is null. */
  copyright(year: number = new Date().getFullYear()): string {
    return `© ${year} ${name}`;
  },
} as const;
