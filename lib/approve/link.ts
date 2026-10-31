/**
 * The link in a signing message (v2 Phase 3, brief 5.10; Sky's decision).
 *
 * A message that asks someone to sign links to /dashboard/approve/[id]. What
 * that link is, and is not:
 *
 *   - It is the business's own address plus the request's id. The id is an
 *     identifier, not a credential: reading the request needs the person's
 *     session and their own business, and a request that is not theirs reads
 *     as absent. There is no query string, no fragment and no token in it.
 *   - It signs nothing. Opening it shows the Approve screen (payee, amount,
 *     asset and fee, decoded on the device from the exact bytes) and nothing
 *     executes until an approver signs with their own passkey.
 *   - It does not replace the transaction code. The message still carries the
 *     code and the screen still asks the person to compare it.
 *   - It fails closed. In production a link is made only on https and never
 *     for a local address; anything else sends the message without a link.
 *
 * No environment is read here: the caller passes the address and the mode.
 */

/** A request id as the server makes it (`wsr_` and a UUID); any plain identifier of this shape is accepted. */
const REQUEST_ID = /^[A-Za-z0-9_-]{8,80}$/;

/** The request header the proxy sets for the layout: the Approve address the browser asked for, nothing else. */
export const RETURN_HEADER = 'x-splash-return';

const PATH_PREFIX = '/dashboard/approve/';

/** The address of one request's Approve screen, or null for an id that is not a plain identifier. */
export function approvePath(id: string): string | null {
  return typeof id === 'string' && REQUEST_ID.test(id) ? `${PATH_PREFIX}${id}` : null;
}

function isLocalHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return h === 'localhost' || h.endsWith('.localhost') || h === '127.0.0.1' || h === '[::1]' || h === '0.0.0.0';
}

/**
 * The full link for a signing message, or null where none may be sent.
 * Only the origin of the configured address is used, so a path, a query, a
 * fragment or credentials in it never reach a message.
 */
export function approveLink(appUrl: string | undefined | null, id: string, env: { NODE_ENV?: string }): string | null {
  const path = approvePath(id);
  if (!path) return null;
  let url: URL;
  try {
    url = new URL(String(appUrl ?? '').trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (env.NODE_ENV === 'production' && (url.protocol !== 'https:' || isLocalHost(url.hostname))) return null;
  return `${url.origin}${path}`;
}

/**
 * Where to go after signing in: the Approve screen of one request, or null
 * (Home). The only shape accepted is exactly `/dashboard/approve/<id>`; another
 * site, another path, a query, a fragment, a doubled slash or a dot segment is
 * Home, so a link can never carry a person somewhere the product did not choose.
 */
export function safeApproveReturn(value: unknown): string | null {
  if (typeof value !== 'string' || !value.startsWith(PATH_PREFIX)) return null;
  return approvePath(value.slice(PATH_PREFIX.length)) === value ? value : null;
}

/**
 * What the proxy does with the request headers: drop whatever the browser sent
 * under the return header's name, then set it from the path for the one shape
 * the layout may use. A request that does not render a page carries none.
 */
export function withReturnHeader(headers: Headers, pathname: string, rendersPage: boolean): Headers {
  headers.delete(RETURN_HEADER);
  const back = rendersPage ? safeApproveReturn(pathname) : null;
  if (back) headers.set(RETURN_HEADER, back);
  return headers;
}

export function loginRedirectFor(_header: string | null | undefined): string {
  return '/login';
}

/** What the signing message says about its link, in the words every channel uses. */
export const LINK_NOTE = 'The link only opens the review. It signs nothing and carries no secret; nothing happens until you sign with your passkey.';
