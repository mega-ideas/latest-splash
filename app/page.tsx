import LandingV2 from "@/components/landing-v2/LandingV2";
import { brand } from "@/lib/brand";

const SITE_URL = brand.siteUrl;

// Organization schema: contactPoint only — deliberately no founder Person.
const organizationJsonLd = {
  "@context": "https://schema.org",
  "@type": "Organization",
  name: brand.name,
  legalName: brand.legalEntity,
  url: SITE_URL,
  logo: `${SITE_URL}${brand.assets.icon}`,
  description:
    "Compliance-gated B2B account network for cross-border payments in Southeast Asia: collect USD, pay out locally, with human approval on every AI-prepared action.",
  contactPoint: {
    "@type": "ContactPoint",
    contactType: "customer support",
    email: brand.supportEmail,
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
        text: "Splash is a compliance-gated B2B account network for cross-border money in Southeast Asia. Businesses send USD and pay out locally — starting with the Philippines and Indonesia — with human approval on every AI-prepared action. No customer funds are held until MFCA activation.",
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
        text: "Corridor fees are illustrative and start from a 0.80% edge fee; the exact fee varies by corridor and volume. Programmable settlement is gas-sponsored — you never hold SUI.",
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
      name: "Does Splash pay a treasury rate today?",
      acceptedAnswer: {
        "@type": "Answer",
        text: "No. Smart Treasury is a roadmap capability shown as a projection with a variable rate, never a fixed figure. It goes live only when the e-money licence is granted, and every treasury action requires explicit business approval.",
      },
    },
  ],
};

export default function Home() {
  // One responsive tree for every device: viewport width queries decide the
  // reflow and the non-pinned hero, never the user agent.
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
      <LandingV2 />
    </>
  );
}
