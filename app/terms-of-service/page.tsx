import type { Metadata } from 'next';

import LegalShell from '@/components/legal/LegalShell';

const legalApproved = process.env.LEGAL_APPROVED === 'true';

export const metadata: Metadata = {
  title: 'Terms of service — Splash',
  description:
    'The terms for using Splash: what this environment is, who may use it, how authority to move value works, and the limits of what we promise.',
  // Draft until counsel signs off — keep the page out of indexes.
  robots: legalApproved ? undefined : { index: false, follow: false },
};

export default function TermsOfServicePage() {
  return (
    <LegalShell
      kicker="Legal"
      title="Terms of service"
      intro="What this environment is, who may use it, how authority to move value is separated, and the limits of what we promise."
      updated="5 September 2026"
      draft={!legalApproved && process.env.NODE_ENV !== 'production'}
    >
      <h2>1. These terms</h2>
      <p>
        These terms are an agreement between you and Splash Financial Labuan Ltd.
        (&ldquo;Splash&rdquo;, &ldquo;we&rdquo;). By creating an account or using the service you
        accept them. If you are accepting on behalf of a company, you confirm you are authorised to
        bind it, and &ldquo;you&rdquo; means that company.
      </p>

      <h2>2. What this environment is</h2>
      <p>
        <strong>v2.splashz.xyz is a demonstration environment.</strong> It runs against the Sui test
        network. The tokens it moves are test tokens with no monetary value and cannot be exchanged
        for anything. Some third-party integrations are simulated rather than live.
      </p>
      <p>
        Do not send real money through it, do not rely on it for a real payment obligation, and do
        not treat anything it displays as a financial record. We may reset, change or delete this
        environment and its data at any time, without notice.
      </p>

      <h2>3. Our regulatory position</h2>
      <p>
        Splash is not yet a licensed money-services business. Where a step in a payment is a
        regulated activity, a licensed partner is the system of record and performs it under its own
        licence, subject to its own terms and its own checks. Splash provides the software and the
        settlement layer between those parties.
      </p>
      <p>
        Nothing here is an offer of a regulated financial service by Splash, and nothing on this
        site is financial, tax, accounting or legal advice.
      </p>

      <h2>4. Who may use it</h2>
      <p>
        You must be at least 18 and using the service for business purposes. You must not be subject
        to sanctions, or located in a jurisdiction we cannot serve. We may refuse or withdraw access
        at our discretion, including where a partner or a check requires it.
      </p>

      <h2>5. Accounts and authority</h2>
      <p>
        Signing up gives you an identity. It does not, by itself, give you authority to do anything
        — authority is granted separately as a membership in an organisation, with a role. Roles
        differ in what they permit, and some permit money to move.
      </p>
      <p>
        Where the product requires a second person to approve an instruction, you must not attempt to
        defeat that separation, including by using another person&rsquo;s credentials or by holding
        two roles that are meant to be held by two people.
      </p>
      <p>
        You are responsible for everything done under your account and for keeping your sign-in and
        your devices secure. A passkey&rsquo;s private key is held by your device and not by us: if
        you lose every registered device you may lose access, and we cannot recover it for you. Tell
        us promptly if you suspect unauthorised use.
      </p>

      <h2>6. Instructions and settlement</h2>
      <p>
        When you submit an instruction you are asking us to act on it. It is not accepted until the
        product shows it as accepted, and it may be delayed or refused where a check, a partner, or
        the law requires. Rates and fees shown before you confirm are indicative unless the product
        states otherwise at the moment of confirmation.
      </p>
      <p>
        A blockchain transaction, once broadcast and confirmed, cannot be reversed by us. Check the
        destination before you confirm. Sending to a wrong or unrecoverable address is not something
        we can undo.
      </p>

      <h2>7. Acceptable use</h2>
      <p>You must not:</p>
      <ul>
        <li>break the law, or use the service to launder money, finance terrorism, or evade sanctions;</li>
        <li>impersonate anyone, or submit information you know to be false;</li>
        <li>probe, scan, overload or attempt to gain unauthorised access to the service or its infrastructure;</li>
        <li>reverse engineer, scrape at scale, or resell the service without our written agreement;</li>
        <li>upload malware, or content you have no right to share.</li>
      </ul>
      <p>
        Good-faith security research is welcome. Report what you find to the address in section 13
        rather than disclosing it publicly, and do not access, alter or exfiltrate other
        people&rsquo;s data while testing.
      </p>

      <h2>8. Your content</h2>
      <p>
        You keep ownership of what you upload. You grant us the licence we need to host, process and
        display it in order to run the service for you. You confirm you have the right to give us
        the data you provide, including anyone else&rsquo;s details you enter.
      </p>

      <h2>9. Our intellectual property</h2>
      <p>
        The service, its interface and its content are owned by Splash or our licensors. These terms
        grant you a limited, non-exclusive, non-transferable, revocable right to use the service.
        Where a component is published under an open-source licence, that licence governs it.
      </p>

      <h2>10. Availability</h2>
      <p>
        We give no uptime commitment for this environment. It may be unavailable for maintenance, for
        a dependency failure, or because a public test network is congested or reset — a test network
        carries no availability guarantee from anyone, including its operators.
      </p>

      <h2>11. Disclaimers and liability</h2>
      <p>
        To the fullest extent the law allows, the service is provided &ldquo;as is&rdquo; and
        &ldquo;as available&rdquo;, without warranties of any kind, express or implied, including
        merchantability, fitness for a particular purpose and non-infringement.
      </p>
      <p>
        To the fullest extent the law allows, we are not liable for indirect, incidental, special,
        consequential or punitive damages, nor for lost profits, revenue, goodwill or data. Our total
        liability arising out of or relating to the service is limited to the greater of the fees you
        paid us in the three months before the claim, or USD 100.
      </p>
      <p>
        Nothing in these terms limits liability that cannot be limited by law, including for fraud,
        fraudulent misrepresentation, or death or personal injury caused by negligence.
      </p>

      <h2>12. Indemnity, suspension and ending</h2>
      <p>
        You will indemnify us against claims arising from your breach of these terms, your misuse of
        the service, or your infringement of someone else&rsquo;s rights.
      </p>
      <p>
        You may stop using the service at any time. We may suspend or end your access where you
        breach these terms, where we are required to, or where we reasonably suspect fraud or a
        security risk. Sections that by their nature should survive — ownership, disclaimers,
        liability, indemnity and governing law — survive.
      </p>

      <h2>13. Governing law, changes and contact</h2>
      <p>
        These terms are governed by the laws of Malaysia, and the courts of Malaysia have exclusive
        jurisdiction, without prejudice to any mandatory protection you have as a consumer where you
        live.
      </p>
      <p>
        We may change these terms. We will update the date at the top of this page and, for a
        material change, tell you before it takes effect. Continuing to use the service after that
        means you accept the change.
      </p>
      <p>
        Contact: <a href="mailto:legal@splashz.xyz">legal@splashz.xyz</a>. Security reports:{' '}
        <a href="mailto:security@splashz.xyz">security@splashz.xyz</a>. How we handle personal data
        is described in our <a href="/privacy-policy">privacy policy</a>.
      </p>
    </LegalShell>
  );
}
