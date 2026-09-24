import type { NextConfig } from "next";

import { SECURITY_HEADERS } from "./lib/security/headers.ts";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  async headers() {
    // The five static headers, on every response — API routes included. The
    // Content-Security-Policy is per request (it carries the nonce) and is
    // set by proxy.ts, never here.
    return [{ source: "/(.*)", headers: [...SECURITY_HEADERS] }];
  },
  allowedDevOrigins: ['127.0.0.1', 'localhost'],
  turbopack: {
    root: process.cwd(),
  },
  // lib/server/seal-config.ts reads config/seal.<NODE_ENV>.json at a path it
  // picks at run time, so its reads are marked turbopackIgnore (untraced, they
  // pulled the whole project into every server output). The committed files
  // are included here instead, for every route that might reach Seal.
  outputFileTracingIncludes: {
    '/*': ['./config/seal.*.json'],
  },
  images: {
    // 90 is used by the landing hero artwork for crispness under scale.
    qualities: [75, 90],
    // /_next/image decodes whatever these patterns admit, unauthenticated.
    // Every <Image> in the app is a file in public/ (the avatar preview is a
    // blob: URL and the deposit QR a data: URL, both `unoptimized`), so no
    // remote host is allowed at all. A remote image is a new pattern here, as
    // narrow as its host and path allow — never a wildcard hostname.
    remotePatterns: [],
    // Local images are fetched through the router without the caller's
    // cookies, so without this list any unauthenticated route that returns
    // bytes would feed the decoder. Only the asset folders in public/, and no
    // query strings.
    localPatterns: [
      { pathname: "/cinematic/**", search: "" },
      { pathname: "/isometric/**", search: "" },
      { pathname: "/partners/**", search: "" },
      { pathname: "/splash-main-icon.png", search: "" },
      { pathname: "/airwallex-logo.png", search: "" },
      { pathname: "/sumsub-logo.png", search: "" },
      { pathname: "/deepbook-mark.png", search: "" },
    ],
    // A redirect is followed without re-checking remotePatterns (16.3 follows
    // 3 by default), so follow none. dangerouslyAllowLocalIP is already false
    // by default; pinned so it cannot drift.
    maximumRedirects: 0,
    dangerouslyAllowLocalIP: false,
  },
};

export default nextConfig;
