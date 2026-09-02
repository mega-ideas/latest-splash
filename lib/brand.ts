/**
 * Brand configuration — the only place the product name, wordmark, legal
 * entity and brand assets are spelled out. New code imports from here; a
 * hardcoded "Splash" string in new code is a review finding.
 *
 * REBRAND GATE: re-review name before any US-facing fundraise or US-market materials.
 */

export const brand = {
  /** Product name as it appears in UI chrome and copy. */
  name: 'Splash',
  /** Wordmark text; the trailing dot is rendered by the wordmark component. */
  wordmark: 'Splash',
  /** Agent persona name. */
  agentName: '0xWal',
  /** Operating legal entity, as it appears in footers and receipts. */
  legalEntity: 'Splash Financial Labuan Ltd.',
  /** Public site origin (canonical URLs, JSON-LD). */
  siteUrl: process.env.NEXT_PUBLIC_APP_URL ?? 'https://splash.finance',
  supportEmail: process.env.NEXT_PUBLIC_SUPPORT_EMAIL ?? 'support@splash.finance',
  /** One asset directory for every brand mark. */
  assets: {
    icon: '/brand/splash-icon.png',
    mark: '/brand/splash-mark.png',
    ogAlt: 'Splash — send USD across Southeast Asia in minutes',
  },
  /**
   * Regulatory posture line shown in every footer. "Regulator-ready" is a
   * design claim about the package split, never a licence claim.
   */
  postureLine: 'Technology platform, not a bank. Operated by Splash Financial Labuan Ltd. Regulator-ready by design.',
  copyright: `© ${new Date().getFullYear()} Splash Financial Labuan Ltd.`,
} as const;

export type Brand = typeof brand;
