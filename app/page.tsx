import { headers } from "next/headers";

import IsometricLanding from "@/components/IsometricLanding";
import { isPhoneUserAgent } from "@/lib/device";

const SITE_URL = "https://splash.finance";

// Organization schema: contactPoint only — deliberately no founder Person.
const organizationJsonLd = {
  "@context": "https://schema.org",
  "@type": "Organization",
  name: "Splash",
  legalName: "Splash Financial Labuan Ltd.",
  url: SITE_URL,
  logo: `${SITE_URL}/splash-main-icon.png`,
  description:
    "Compliance-gated B2B account network for cross-border payments in Southeast Asia: collect USD, pay out locally, with human approval on every AI-prepared action.",
  contactPoint: {
    "@type": "ContactPoint",
    contactType: "customer support",
    email: "support@splash.finance",
  },
};

const faqJsonLd = {
  "@context": "https://schema.org",
  "@type": "FAQPage",
  mainEntity: [
    {
      "@type": "Question",
      name: "What is Splash?",
      acceptedAnswer: {
        "@type": "Answer",
        text: "Splash is a compliance-gated B2B account network for cross-border money in Southeast Asia. Businesses collect USD and pay out locally — starting with the USD to PHP corridor on testnet — with human approval on every AI-prepared action.",
      },
    },
    {
      "@type": "Question",
      name: "Is Splash a licensed money-services business?",
      acceptedAnswer: {
        "@type": "Answer",
        text: "Not yet. Licensed partners are the system of record for regulated activities today, and Splash's own licensing path (Labuan FSA in process; BNM MSB and BSP planned) is documented on the Trust & compliance page.",
      },
    },
    {
      "@type": "Question",
      name: "How fast do payments settle?",
      acceptedAnswer: {
        "@type": "Answer",
        text: "Settlement on Sui reaches finality in roughly 400 milliseconds. End-to-end delivery time depends on the local payout rail for the corridor.",
      },
    },
    {
      "@type": "Question",
      name: "What does a payout cost?",
      acceptedAnswer: {
        "@type": "Answer",
        text: "Corridor fees start from a 0.80% edge fee. Simple USD payouts ride Sui's zero-fee rail and programmable settlement is gas-sponsored — you never hold SUI.",
      },
    },
    {
      "@type": "Question",
      name: "Does the AI move money?",
      acceptedAnswer: {
        "@type": "Answer",
        text: "No. 0xWal prepares unsigned proposals; deterministic policy checks, safety guards, and your human approval are what release funds. Every settlement anchors Seal-encrypted evidence on Walrus and Sui.",
      },
    },
    {
      "@type": "Question",
      name: "Is the treasury yield fixed?",
      acceptedAnswer: {
        "@type": "Answer",
        text: "No. Treasury posture is a projection with a variable rate — never a fixed figure — and every treasury action requires explicit business approval.",
      },
    },
  ],
};

export default async function Home() {
  // Every device gets the isometric cinematic — the desktop identity — but
  // phones get it "shrunk to fit": a reflowed single column with readable
  // type, and the non-pinned static hero instead of the scroll-jacked one.
  // Phone is decided server-side from the UA so the right hero arrives on
  // the first byte (no flash), and CSS width queries handle the reflow.
  const headerStore = await headers();
  const isPhone = isPhoneUserAgent(headerStore.get("user-agent"));

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(organizationJsonLd).replace(/</g, "\\u003c") }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(faqJsonLd).replace(/</g, "\\u003c") }}
      />
      <IsometricLanding isPhone={isPhone} />
    </>
  );
}
