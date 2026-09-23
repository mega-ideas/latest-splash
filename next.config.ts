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
  images: {
    // 90 is used by the landing hero artwork for crispness under scale.
    qualities: [75, 90],
    remotePatterns: [
      {
        protocol: "https",
        hostname: "**",
      },
    ],
  },
};

export default nextConfig;
