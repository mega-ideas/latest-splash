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
  description:
    "Send USD across Southeast Asia in minutes, starting with the Philippines and Indonesia. Atomic settlement on Sui, human approval on every action. No customer funds until MFCA activation.",
  openGraph: {
    title: "Splash - Working-capital network for SEA payouts",
    description: "Send USD across Southeast Asia in minutes. Settled atomically on Sui, proven on-chain.",
  },
  twitter: {
    card: "summary_large_image",
    title: "Splash - Working-capital network for SEA payouts",
    description: "Send USD across Southeast Asia in minutes. Settled atomically on Sui, proven on-chain.",
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
      <head>
        {/* Apply a stored theme choice before first paint; no choice = system. */}
        <script
          dangerouslySetInnerHTML={{
            __html:
              "try{var t=localStorage.getItem('splash-theme');if(t==='dark'||t==='light'){document.documentElement.setAttribute('data-theme',t)}}catch(e){}",
          }}
        />
      </head>
      <body suppressHydrationWarning className="min-h-full splash-page-bg text-[#326273]">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
