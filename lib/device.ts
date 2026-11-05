/**
 * Phone detection from the User-Agent, decided server-side so the right
 * layout renders on the first byte (no client-side flash or CLS).
 *
 * Deliberate segmentation: PHONES get the dedicated mobile landing;
 * tablets (iPad et al.) keep the desktop/isometric design, which is built
 * for desktop, laptop and iPad viewports.
 *
 * Note: iPadOS 13+ reports a Macintosh UA, which lands it on the desktop
 * design — exactly the segmentation we want.
 */
export function isPhoneUserAgent(userAgent: string | null | undefined): boolean {
  if (!userAgent) return false;

  // Android tablets have "Android" WITHOUT "Mobile"; phones include both.
  if (/Android/i.test(userAgent)) return /Mobile/i.test(userAgent);

  return /iPhone|iPod|Windows Phone|BlackBerry|Opera Mini|Mobi/i.test(userAgent);
}

/**
 * The dashboard's phone layouts (v2 brief 5.10) switch at the width the shell
 * already switches its rail for: below Tailwind's `md`, 768px.
 */
export const PHONE_MAX_WIDTH = 767;
export const PHONE_MEDIA_QUERY = `(max-width: ${PHONE_MAX_WIDTH}px)`;

/**
 * The server's hint about the device, read where a layout renders. It is only
 * the first paint: the window's width decides once the page can ask it
 * (`resolvePhone`), so a tablet keeps the desktop layout and a desktop window
 * narrowed to a phone gets the phone one.
 */
export function phoneHintFromHeaders(headers: { get(name: string): string | null }): boolean {
  return isPhoneUserAgent(headers.get('user-agent'));
}

/** The window's answer when it can be asked, the server's hint until then. */
export function resolvePhone(hint: boolean, matches: boolean | null): boolean {
  return matches ?? hint;
}
