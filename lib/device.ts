/**
 * Phone detection from the User-Agent.
 *
 * NON-VISUAL USE ONLY. Layout is decided by viewport width queries in one
 * responsive tree; never branch rendering on this helper. It remains for
 * server-side concerns such as analytics tagging or rate-limit heuristics.
 *
 * Note: iPadOS 13+ reports a Macintosh UA and therefore reads as desktop.
 */
export function isPhoneUserAgent(userAgent: string | null | undefined): boolean {
  if (!userAgent) return false;

  // Android tablets have "Android" WITHOUT "Mobile"; phones include both.
  if (/Android/i.test(userAgent)) return /Mobile/i.test(userAgent);

  return /iPhone|iPod|Windows Phone|BlackBerry|Opera Mini|Mobi/i.test(userAgent);
}
