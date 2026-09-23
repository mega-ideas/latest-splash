import { headers } from "next/headers";

import IsometricLanding from "@/components/IsometricLanding";
import { LANDING_FAQ } from "@/components/landing/Landing";
import { BRAND } from "@/content/brand";
import { isPhoneUserAgent } from "@/lib/device";

/**
 * The landing route.
 *
 * The page itself is the v1 isometric cinematic, restored. The structured
 * data below is NOT v1's: that version named a company that was never
 * incorporated, set out a licensing timeline, and quoted a sub-second
 * settlement figure with no source — all removed by the truth pass, and all
 * refused today by scripts/check-copy.mjs and tests/landing-and-numbers.
 * The schema here names no company, claims no licence, and answers the same
 * questions the product answers elsewhere.
 */

// contactPoint only. No legal-entity name, deliberately — no entity is
// incorporated yet, and the name that used to sit here was the trademark
// holder's. Nothing renders an entity until content/brand.ts has one.
const organizationJsonLd = {
  "@context": "https://schema.org",
  "@type": "Organization",
  name: BRAND.name,
  url: BRAND.siteUrl,
  logo: `${BRAND.siteUrl}/splash-main-icon.png`,
  description:
    "Payments from US dollars to Philippine pesos for businesses, with a record for both sides. A person approves every payment.",
  contactPoint: {
    "@type": "ContactPoint",
    contactType: "customer support",
    email: BRAND.supportEmail,
  },
};

// The same questions the product answers elsewhere, so search results and the
// site agree. Shared with components/landing/Landing.tsx.
const faqJsonLd = {
  "@context": "https://schema.org",
  "@type": "FAQPage",
  mainEntity: LANDING_FAQ.map((item) => ({
    "@type": "Question",
    name: item.q,
    acceptedAnswer: { "@type": "Answer", text: item.a },
  })),
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
