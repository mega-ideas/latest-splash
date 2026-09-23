import type { Metadata } from 'next';

import LegalShell from '@/components/legal/LegalShell';

const legalApproved = process.env.LEGAL_APPROVED === 'true';

export const metadata: Metadata = {
  title: 'Privacy policy — Splash',
  description:
    'What Splash collects when you sign in, what is written to a public blockchain and therefore permanent, how long records are kept, and how to reach us.',
  // Draft until counsel signs off — keep the page out of indexes.
  robots: legalApproved ? undefined : { index: false, follow: false },
};

export default function PrivacyPolicyPage() {
  return (
    <LegalShell
      kicker="Legal"
      title="Privacy policy"
      intro="What we collect, why we collect it, what becomes permanent because it is written to a public blockchain, and how to ask us to delete the rest."
      updated="5 September 2026"
      draft={!legalApproved && process.env.NODE_ENV !== 'production'}
    >
      <h2>1. Who we are</h2>
      <p>
        Splash Financial Labuan Ltd. (&ldquo;Splash&rdquo;, &ldquo;we&rdquo;) operates the software
        described in this policy. Splash is the controller of the personal data described below.
        Where a licensed partner is the system of record for a regulated activity, that partner is
        the controller of the data it holds under its own licence and its own privacy notice.
      </p>

      <h2>2. Which service this covers</h2>
      <p>
        This policy covers <strong>v2.splashz.xyz</strong>, which is a demonstration environment. It
        runs against the Sui test network, and the tokens it moves are test tokens with no monetary
        value. Do not use it to send real money and do not upload data you would not want in a test
        system.
      </p>

      <h2>3. What we collect</h2>

      <h3>Sign-in with Google (zkLogin)</h3>
      <p>
        When you sign in, Google returns an identity token to your browser and your browser sends it
        to us. From that token we read and store your email address, the issuer, the subject
        identifier Google assigns you, and the audience (our client identifier). We derive a Sui
        blockchain address from those values plus a secret salt, and store it so an approval can
        later be attributed to a named person.
      </p>
      <p>
        <strong>We never receive your Google password</strong>, and we never ask for one.
      </p>
      <p>
        Please read this next part carefully, because zkLogin is easy to overestimate. The
        zero-knowledge proof keeps your Google account private <em>from the blockchain</em> — an
        observer of the chain sees an address, not an email. It does <em>not</em> keep it private
        from us: our server verifies the token, so we see and store your email address. Anyone
        telling you zkLogin makes you anonymous to the operator is describing a different system.
      </p>
      <p>
        We do not write your raw subject identifier to our logs. Where a log entry needs to
        distinguish one account from another it records a truncated hash instead.
      </p>

      <h3>Passkeys</h3>
      <p>
        If you register a passkey we store its public key, its credential identifier, the domain it
        was registered for, and timestamps for creation, last use and revocation. The private key is
        created by your device and never leaves it, so we cannot use your passkey and cannot recover
        it for you.
      </p>

      <h3>Using the product</h3>
      <p>
        Records of what you do: organisations and roles, payment instructions and their status,
        recipients you enter, approvals you give, invoices and supporting documents you upload, and
        support messages you send us. Where you enter another person&rsquo;s details — a supplier or
        a recipient — you are responsible for having a basis to share them with us.
      </p>

      <h3>Technical data</h3>
      <p>
        A session cookie that keeps you signed in, plus ordinary server logs: IP address, request
        time and path, user agent, and errors. We use these to keep the service running and to
        investigate abuse. We do not use advertising cookies and we do not run third-party
        advertising trackers.
      </p>

      <h2>4. What is permanent, and why that matters</h2>
      <p>
        Some records are anchored to a public blockchain to make them tamper-evident. Anchored
        records are <strong>permanent and publicly readable, and we cannot delete or alter
        them</strong> — that is the property that makes an audit trail worth having, and it is also
        an irreversible disclosure. So what goes on chain is deliberately narrow.
      </p>
      <p>
        On chain: a hash of a record, a pointer to encrypted storage, amounts, currencies, corridor
        identifiers, timestamps, and blockchain addresses. The underlying document is encrypted
        before it is stored and the encryption key is held under a threshold policy, so the contents
        are not public even though the anchor is.
      </p>
      <p>
        Not on chain: your email address, your name, your passkey, your uploaded documents, or your
        support messages.
      </p>
      <p>
        A blockchain address is pseudonymous, not anonymous. Anyone who learns that an address is
        yours can read everything that address has ever done.
      </p>

      <h2>5. Why we are allowed to use it</h2>
      <ul>
        <li><strong>To perform our contract with you</strong> — running your account and carrying out instructions you give.</li>
        <li><strong>Legal obligation</strong> — record-keeping, and financial-crime checks carried out by us or by a partner of record.</li>
        <li><strong>Legitimate interests</strong> — keeping the service available, preventing fraud and abuse, and improving what we build. We balance these against your interests.</li>
        <li><strong>Consent</strong> — where we ask for it, and which you can withdraw.</li>
      </ul>

      <h2>6. Who we share it with</h2>
      <p>
        Licensed partners who are the system of record for a regulated step, where an instruction you
        gave requires it. Service providers who host and operate our infrastructure, under contract
        and only on our instructions. Authorities, where the law requires it. Professional advisers,
        under a duty of confidentiality. A successor entity, if the business is transferred.
      </p>
      <p>
        <strong>We do not sell personal data, and we do not share it for third-party advertising.</strong>
      </p>

      <h2>7. Where it goes</h2>
      <p>
        Our infrastructure is hosted in Singapore. A public blockchain is replicated worldwide by
        design, so anything anchored to it is, by definition, transferred internationally and cannot
        be recalled. Where we transfer other personal data across borders we use contractual
        protections appropriate to the destination.
      </p>

      <h2>8. How long we keep it</h2>
      <p>
        Account and transaction records: for the life of the account and then for as long as
        financial record-keeping rules require, which is typically seven years. Server logs: a
        rolling short retention. Anchored records: permanently, because they cannot be removed.
        Demonstration data on this environment may be deleted at any time without notice.
      </p>

      <h2>9. Your rights</h2>
      <p>
        Subject to local law you may ask us for a copy of your data, ask us to correct it, ask us to
        delete it, object to or restrict a use, ask for portability, or withdraw a consent. Write to
        the address in section 12 and we will respond within the period the applicable law allows.
      </p>
      <p>
        Two honest limits. We cannot delete what is anchored on a public blockchain, for the reason
        given in section 4. And we cannot delete records we are legally required to retain — in that
        case we restrict them instead of erasing them.
      </p>

      <h2>10. Keeping it safe</h2>
      <p>
        Access to production data is restricted and authenticated. Sensitive evidence is encrypted
        before storage under a threshold policy, so no single key holder can read it alone.
        Authority to move value is separated from the authority to approve it, and both are recorded
        against the person who exercised them.
      </p>
      <p>
        No system is perfectly secure. If a breach affects your rights we will notify you and the
        relevant regulator as the law requires.
      </p>

      <h2>11. Children</h2>
      <p>
        This is a business product and is not directed at children. We do not knowingly collect data
        from anyone under 18. If you believe a child has given us data, contact us and we will
        delete it.
      </p>

      <h2>12. Contact and changes</h2>
      <p>
        Questions, or to exercise a right: <a href="mailto:privacy@splashz.xyz">privacy@splashz.xyz</a>.
        You also have the right to complain to your local data-protection authority.
      </p>
      <p>
        If we change this policy we will update the date at the top of this page, and we will tell
        you directly if the change materially affects your rights.
      </p>
    </LegalShell>
  );
}
