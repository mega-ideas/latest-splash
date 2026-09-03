import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // The design handoff addresses the app as /app/*; the app root stays /dashboard.
  async redirects() {
    return [
      { source: '/app', destination: '/dashboard', permanent: false },
      { source: '/app/payments/new', destination: '/dashboard/send', permanent: false },
      { source: '/app/beneficiaries', destination: '/dashboard/recipients', permanent: false },
      { source: '/app/liquidity', destination: '/dashboard/treasury', permanent: false },
      { source: '/app/:path*', destination: '/dashboard/:path*', permanent: false },
    ];
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
