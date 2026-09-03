import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

import { Providers } from "./providers";

const fontSans = Geist({
  variable: "--font-sans",
  subsets: ["latin"],
});

const fontMono = Geist_Mono({
  variable: "--font-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000"),
  title: "Splash - Working-capital network for SEA payouts",
  description: "Collect USD, pay Southeast Asia, and keep cash working in a labeled sandbox environment.",
  openGraph: {
    title: "Splash - Working-capital network for SEA payouts",
    description: "Collect USD. Pay Southeast Asia. Keep cash working.",
  },
  twitter: {
    card: "summary_large_image",
    title: "Splash - Working-capital network for SEA payouts",
    description: "Collect USD. Pay Southeast Asia. Keep cash working.",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${fontSans.variable} ${fontMono.variable} h-full font-sans antialiased`}
    >
      <body suppressHydrationWarning className="min-h-full splash-page-bg text-[#326273]">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
