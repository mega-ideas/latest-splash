import { randomBytes } from 'node:crypto';

import { NextResponse, type NextRequest } from 'next/server';

import { isAdminHostname } from '@/lib/admin-routing';
import { buildContentSecurityPolicy } from '@/lib/security/csp';

/**
 * Two jobs. The admin-host rewrite it always did, and the Content-Security-
 * Policy every page now carries.
 *
 * The policy is built around a nonce minted here, once per page request,
 * from the CSPRNG. It goes out twice: on the request, as `x-nonce` and as
 * the policy header, which is what Next.js reads during server rendering to
 * attach the nonce to every script it emits; and on the response, which is
 * what the browser enforces. Prefetches, assets and API routes carry no
 * policy — there is nothing to render, and the static headers from
 * next.config.ts cover them. The admin rewrite carries it too: it serves
 * the approval screens, which are the pages that must never be framed.
 */
export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const hostname = request.headers.get('host')?.split(':')[0] ?? '';

  const isPrefetch = request.headers.has('next-router-prefetch') || request.headers.get('purpose') === 'prefetch';
  const rendersPage = !pathname.startsWith('/api') && !pathname.startsWith('/_next') && !isPrefetch;
  const nonce = rendersPage ? randomBytes(16).toString('base64') : null;
  const policy = nonce
    ? buildContentSecurityPolicy({ nonce, isDev: process.env.NODE_ENV === 'development' })
    : null;

  const requestHeaders = new Headers(request.headers);
  if (nonce && policy) {
    requestHeaders.set('x-nonce', nonce);
    requestHeaders.set('Content-Security-Policy', policy);
  }
  const withPolicy = (response: NextResponse) => {
    if (policy) response.headers.set('Content-Security-Policy', policy);
    return response;
  };

  if (!isAdminHostname(hostname)) {
    return withPolicy(NextResponse.next({ request: { headers: requestHeaders } }));
  }

  if (pathname.startsWith('/admin') || pathname.startsWith('/api') || pathname.startsWith('/_next')) {
    return withPolicy(NextResponse.next({ request: { headers: requestHeaders } }));
  }

  const url = request.nextUrl.clone();
  url.pathname = pathname === '/' ? '/admin' : `/admin${pathname}`;

  return withPolicy(NextResponse.rewrite(url, { request: { headers: requestHeaders } }));
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|icon.png|splash-logo.png).*)'],
};
