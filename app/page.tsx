import Landing, { LANDING_FAQ } from "@/components/landing/Landing";
import { BRAND } from "@/content/brand";

// Organization schema: contactPoint only. No legal-entity name, deliberately — no
// entity is incorporated yet, and the name that used to sit here was the
// trademark holder's. Nothing renders an entity until content/brand.ts has one.
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

// The same questions the page answers, so search results and the page agree.
const faqJsonLd = {
  "@context": "https://schema.org",
  "@type": "FAQPage",
  mainEntity: LANDING_FAQ.map((item) => ({
    "@type": "Question",
    name: item.q,
    acceptedAnswer: { "@type": "Answer", text: item.a },
  })),
};

export default function Home() {
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
      <Landing />
    </>
  );
}
