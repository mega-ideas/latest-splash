import { NextResponse, type NextRequest } from 'next/server';

import { isAdminHostname } from '@/lib/admin-routing';

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // /metrics publishes only behind NEXT_PUBLIC_METRICS_LIVE. A notFound()
  // thrown inside a streamed page still answers 200, so the gate lives here
  // and rewrites to a route that does not exist -> the app 404 with a 404 status.
  if (pathname === '/metrics' && process.env.NEXT_PUBLIC_METRICS_LIVE !== 'true') {
    const off = request.nextUrl.clone();
    off.pathname = '/metrics/not-published';
    return NextResponse.rewrite(off);
  }
  const hostname = request.headers.get('host')?.split(':')[0] ?? '';

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
  matcher: ['/((?!_next/static|_next/image|favicon.ico|icon.png|splash-logo.png|brand/).*)'],
};
