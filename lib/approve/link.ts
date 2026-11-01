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
 *   - It fails closed. In production (an unset NODE_ENV is production) a link
 *     is made only on https and a public name: no IP address, no private or
 *     local name; anything else sends the message without a link.
 *
 * No environment is read here: the caller passes the address and the mode.
 */

/** A request id as the server makes it (`wsr_` and a UUID); any plain identifier of this shape is accepted. */
const REQUEST_ID = /^[A-Za-z0-9_-]{8,80}$/;

/** The request header the proxy sets for the layout: the Approve address the browser asked for, nothing else. */
export const RETURN_HEADER = 'x-splash-return';

const PATH_PREFIX = '/dashboard/approve/';
/** The page one invitation's link opens (v2 Phase 3, the invitation email). Same rules as the Approve link: an id, nothing else. */
const INVITATION_PREFIX = '/dashboard/invitation/';

/** The address of one request's Approve screen, or null for an id that is not a plain identifier. */
export function approvePath(id: string): string | null {
  return typeof id === 'string' && REQUEST_ID.test(id) ? `${PATH_PREFIX}${id}` : null;
}

/** The address of one invitation's page, or null for an id that is not a plain identifier. */
export function invitationPath(id: string): string | null {
  return typeof id === 'string' && REQUEST_ID.test(id) ? `${INVITATION_PREFIX}${id}` : null;
}

/** Names that only mean something on one machine or one network. */
const LOCAL_ONLY_LABELS = new Set(['localhost', 'local', 'localdomain', 'internal', 'lan', 'intranet']);

/** The host without the trailing dot of a fully qualified name ("example.com." is "example.com"). */
function bareHost(hostname: string): string {
  return hostname.toLowerCase().replace(/\.+$/, '');
}

/**
 * Whether a host may appear in a link that goes out of the building. Refused:
 * any IP address (the URL parser has already turned 2130706433, 0x7f000001 and
 * 127.1 into 127.0.0.1, and IPv6 and IPv4-mapped forms keep their brackets, so
 * loopback, private, link-local and shared ranges all fall here), a name with
 * no dot (an intranet or machine name), a name whose last label has no letter
 * (an IPv4 form), and names that are local by convention (.localhost, .local,
 * .internal, .home.arpa and the like). What is left is a public name.
 */
function isPublicHost(hostname: string): boolean {
  const host = bareHost(hostname);
  if (host === '' || host.startsWith('[')) return false;
  const labels = host.split('.');
  if (labels.length < 2 || labels.some((label) => label === '')) return false;
  const last = labels[labels.length - 1];
  if (!/[a-z]/.test(last) || LOCAL_ONLY_LABELS.has(last)) return false;
  if (host.endsWith('.home.arpa')) return false;
  return true;
}

/** Only development and test are not production: an unset or unknown mode is treated as production. */
function isProduction(env: { NODE_ENV?: string }): boolean {
  return env.NODE_ENV !== 'development' && env.NODE_ENV !== 'test';
}

/**
 * The full link to one path of this app, or null where none may be sent.
 * Only the origin of the configured address is used, so a path, a query, a
 * fragment or credentials in it never reach a message. In production (which an
 * unset NODE_ENV is) the address must be https on a public name.
 */
function appLink(appUrl: string | undefined | null, path: string | null, env: { NODE_ENV?: string }): string | null {
  if (!path) return null;
  let url: URL;
  try {
    url = new URL(String(appUrl ?? '').trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (isProduction(env) && (url.protocol !== 'https:' || !isPublicHost(url.hostname))) return null;
  const host = bareHost(url.hostname);
  return `${url.protocol}//${host}${url.port ? `:${url.port}` : ''}${path}`;
}

/** The full link for a signing message, or null where none may be sent. */
export function approveLink(appUrl: string | undefined | null, id: string, env: { NODE_ENV?: string }): string | null {
  return appLink(appUrl, approvePath(id), env);
}

/** The full link in an invitation email, or null where none may be sent. It carries an id and no secret: opening it asks for sign-in and accepts nothing. */
export function invitationLink(appUrl: string | undefined | null, id: string, env: { NODE_ENV?: string }): string | null {
  return appLink(appUrl, invitationPath(id), env);
}

/**
 * Where to go after signing in: the Approve screen of one request, or one
 * invitation's page, or null (Home). The only shapes accepted are exactly
 * `/dashboard/approve/<id>` and `/dashboard/invitation/<id>`; another
 * site, another path, a query, a fragment, a doubled slash or a dot segment is
 * Home, so a link can never carry a person somewhere the product did not choose.
 */
export function safeApproveReturn(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  if (value.startsWith(PATH_PREFIX)) return approvePath(value.slice(PATH_PREFIX.length)) === value ? value : null;
  // The one other place a link may bring a signed-out person back to: the invitation they were emailed.
  if (value.startsWith(INVITATION_PREFIX)) return invitationPath(value.slice(INVITATION_PREFIX.length)) === value ? value : null;
  return null;
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

/**
 * Where the dashboard layout sends a signed-out visit: sign in, and for a link
 * to one request's Approve screen come back to it afterwards. The header is the
 * proxy's (withReturnHeader), and only the one allowed shape is believed.
 */
export function loginRedirectFor(header: string | null | undefined): string {
  const back = safeApproveReturn(header);
  return back ? `/login?next=${encodeURIComponent(back)}` : '/login';
}

/** What the signing message says about its link, in the words every channel uses. */
export const LINK_NOTE = 'The link only opens the review. It signs nothing and carries no secret; nothing happens until you sign with your passkey.';
