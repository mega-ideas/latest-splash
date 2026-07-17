import { NextResponse, type NextRequest } from 'next/server';

import { isAdminHostname } from '@/lib/admin-routing';

/**
 * IA restructure (suppliers-first): legacy dashboard routes 302 to their
 * successors at the proxy layer so the redirect is a real HTTP 302 (not a
 * streamed NEXT_REDIRECT payload) and old deep links keep their query
 * strings. Matching page-level stubs remain as belt-and-braces for
 * client-side navigations.
 */
const LEGACY_ROUTES: Record<string, string> = {
  '/dashboard/overview': '/dashboard',
  '/dashboard/recipients': '/dashboard/suppliers',
  '/dashboard/transfer': '/dashboard/payments/new',
  '/dashboard/batch': '/dashboard/payments/runs',
  '/dashboard/transfers': '/dashboard/payments/rate-holds',
  '/dashboard/history': '/dashboard/payments/history',
  '/dashboard/payments': '/dashboard/payments/new',
  '/queue': '/dashboard',
};

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const hostname = request.headers.get('host')?.split(':')[0] ?? '';

  const legacyTarget = LEGACY_ROUTES[pathname];
  if (legacyTarget) {
    const url = request.nextUrl.clone();
    url.pathname = legacyTarget;
    return NextResponse.redirect(url, 302);
  }

  if (!isAdminHostname(hostname)) {
    return NextResponse.next();
  }

  if (pathname.startsWith('/admin') || pathname.startsWith('/api') || pathname.startsWith('/_next')) {
    return NextResponse.next();
  }

  const url = request.nextUrl.clone();
  url.pathname = pathname === '/' ? '/admin' : `/admin${pathname}`;

  return NextResponse.rewrite(url);
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|icon.png|splash-logo.png).*)'],
};
