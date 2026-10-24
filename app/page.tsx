import { headers } from "next/headers";

import IsometricLanding from "@/components/IsometricLanding";
import { landingFaq } from "@/content/landing-faq";
import { BRAND } from "@/content/brand";
import { isPhoneUserAgent } from "@/lib/device";
import { pricingSummary, scheduleToWire } from "@/lib/fees/copy";
import { publishedFeeSchedule } from "@/lib/fees/fee-config";
import { PARTNERS, type PartnerId } from "@/lib/partners/signed-partners";
import { signedPartners } from "@/lib/server/signed-partners";

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
// site agree. Shared with content/landing-faq.ts, and priced from the
// same schedule as the page (A1 §2.7).
function faqJsonLd(faq: ReturnType<typeof landingFaq>) {
  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: faq.map((item) => ({
      "@type": "Question",
      name: item.q,
      acceptedAnswer: { "@type": "Answer", text: item.a },
    })),
  };
}

/** A signed partner's role as a label: "Philippines payout partner", not "our Philippines payout partner". */
function roleOf(id: PartnerId): string {
  const role = PARTNERS[id].role.replace(/^(?:our|an?)\s+/, "");
  return role.charAt(0).toUpperCase() + role.slice(1);
}

export default async function Home() {
  // Every device gets the isometric cinematic — the desktop identity — but
  // phones get it "shrunk to fit": a reflowed single column with readable
  // type, and the non-pinned static hero instead of the scroll-jacked one.
  // Phone is decided server-side from the UA so the right hero arrives on
  // the first byte (no flash), and CSS width queries handle the reflow.
  const headerStore = await headers();
  const isPhone = isPhoneUserAgent(headerStore.get("user-agent"));
  // Splash's prices, in words, from the fee schedule in force: the live
  // FeeConfig when it can be read, the launch schedule when it cannot
  // (lib/fees/fee-config.ts). Never typed into the page. While the
  // FeeConfig's fees are off, the page says no Splash fee is charged yet.
  const { schedule, feesOn } = await publishedFeeSchedule();
  const pricing = pricingSummary(schedule, { feesOn });
  // Who may be named: SIGNED_PARTNERS, read here on the server, empty by
  // default. The landing renders partners only from this list, and the rails
  // and standards while it is empty (brief section 6).
  const signed = signedPartners();
  const signedList = [...signed].map((id) => ({ name: PARTNERS[id].name, role: roleOf(id) }));
  const fundingIds: PartnerId[] = ["stripe", "halliday", "transfi", "bridge"];
  const fundingPartners = fundingIds.filter((id) => signed.has(id)).map((id) => PARTNERS[id].name);

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(organizationJsonLd).replace(/</g, "\\u003c") }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(faqJsonLd(landingFaq(schedule, { feesOn }))).replace(/</g, "\\u003c") }}
      />
      <IsometricLanding
        isPhone={isPhone}
        pricing={pricing}
        fees={{ schedule: scheduleToWire(schedule), feesOn }}
        signedPartners={signedList}
        fundingPartners={fundingPartners}
      />
    </>
  );
}
