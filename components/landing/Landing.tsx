import Image from 'next/image';
import Link from 'next/link';

import FeeCalculator from '@/components/landing/FeeCalculator';
import { BRAND } from '@/content/brand';
import { publishedNumbers } from '@/content/sea-numbers';
import { SPLASH_USD_PHP, formatBps } from '@/lib/fx/calculator';
import { formatMinor } from '@/lib/money';

/**
 * The landing page, straightforward: what a customer receives, what it
 * costs, how it works, the numbers behind it, the price, the questions.
 *
 * Nothing here explains the protocol. The distinctive object is the payment
 * record, because that is the thing a customer keeps. Copy obeys the rules in
 * scripts/copy-rules.mjs: no licence claimed, no entity named, no partner
 * named that has not signed, no yield promised, and no jargon.
 */

/** The questions, shared with the FAQ JSON-LD in app/page.tsx so both say the same thing. */
export const LANDING_FAQ: Array<{ q: string; a: string }> = [
  {
    q: 'Does Splash hold a money-services licence?',
    a: 'Not yet. Splash is not yet a licensed money-services business. Today it runs the software that prepares, approves and records a payment, and partners of record carry out the regulated steps. The trust page says who does what.',
  },
  {
    q: 'What does a payment cost?',
    a: `A flat US$${formatMinor(SPLASH_USD_PHP.flatUsdMinor, 2)} plus ${formatBps(SPLASH_USD_PHP.marginBps)} of the amount on the USD to PHP leg, shown as illustrative until your quote. The exchange rate is quoted when you send and written on the record.`,
  },
  {
    q: 'How long does it take?',
    a: 'The settlement step is final in under a second. Delivery to a Philippine bank or wallet depends on the local rail, and the quote shows the expected time before you approve.',
  },
  {
    q: 'Does the assistant move money?',
    a: 'No. The assistant can prepare a payment and suggest a batch. A person approves every payment, and nothing moves without that approval.',
  },
  {
    q: 'Can Splash hold a balance for me or my supplier?',
    a: 'Not yet. Holding customer funds needs a money-broking licence Splash does not hold. Today Splash pays out only: the supplier is paid, and nothing is kept on your behalf.',
  },
];

export default function Landing() {
  const year = new Date().getFullYear();
  const numbers = publishedNumbers();
  const preview = process.env.NODE_ENV !== 'production';
  const flatFee = `US$${formatMinor(SPLASH_USD_PHP.flatUsdMinor, 2)}`;
  const margin = formatBps(SPLASH_USD_PHP.marginBps);

  return (
    <div className="ld">
      <header className="ld-header">
        <div className="ld-shell ld-header-inner">
          <Link href="/" className="ld-brand" aria-label={`${BRAND.name} home`}>
            <Image src="/splash-main-icon.png" alt="" width={841} height={823} priority />
            <span>{BRAND.name}</span>
          </Link>
          <nav className="ld-nav" aria-label="Sections">
            <a href="#record">The record</a>
            <a href="#calculator">Cost</a>
            <a href="#how-it-works">How it works</a>
            <a href="#pricing">Pricing</a>
            <a href="#faq">Questions</a>
          </nav>
          <div className="ld-header-actions">
            <Link href="/login" className="ld-button ld-button-ghost ld-button-small">
              Sign in
            </Link>
            <Link href="/signup" className="ld-button ld-button-small">
              Start sending
            </Link>
          </div>
        </div>
      </header>

      <main>
        <section id="hero" className="ld-section ld-hero" aria-labelledby="hero-title">
          <div className="ld-shell ld-hero-grid">
            <div>
              <p className="ld-eyebrow">US dollars in, Philippine pesos out, for businesses</p>
              <h1 id="hero-title">Pay a supplier in the Philippines. Keep the record.</h1>
              <p className="ld-hero-sub">
                Fund in US dollars, approve, and the supplier is paid in pesos with a record your accountant
                and auditor can use.
              </p>
              <div className="ld-hero-actions">
                <Link href="/signup" className="ld-button">
                  Start sending
                </Link>
                <a href="#record" className="ld-button ld-button-ghost">
                  See the record
                </a>
              </div>
            </div>
            <div className="ld-hero-art">
              <Image
                src="/cinematic/hero-district-v5.png"
                alt="Isometric illustration of the Splash building on a plinth, ringed by a gold delivery route with couriers on it"
                width={1600}
                height={1000}
                sizes="(min-width: 900px) 48vw, 100vw"
                priority
              />
            </div>
          </div>
        </section>

        <section id="record" className="ld-section" aria-labelledby="record-title">
          <div className="ld-shell ld-record-grid">
            <div>
              <h2 id="record-title">What you get for every payment</h2>
              <p className="ld-lede">
                One record. What left, what arrived, the rate you were quoted, who approved it, and the
                reference the receiving bank shows. It is written when the money moves and it does not
                change afterwards.
              </p>
              <ul className="ld-record-points">
                <li>Your accountant gets the amounts and the rate in one place.</li>
                <li>Your auditor gets who approved it, and when.</li>
                <li>Your supplier gets the same record, so both sides reconcile to it.</li>
              </ul>
            </div>
            <dl className="ld-record-card" aria-label="A sample payment record">
              <span className="ld-record-stamp">Sample</span>
              <h3>Payment record</h3>
              <div className="ld-record-rows">
                <div className="ld-record-row">
                  <dt>Sent</dt>
                  <dd>US$1,000.00</dd>
                </div>
                <div className="ld-record-row">
                  <dt>Fee (illustrative)</dt>
                  <dd>US$12.50</dd>
                </div>
                <div className="ld-record-row">
                  <dt>Rate quoted (sample)</dt>
                  <dd>56.00 PHP per USD</dd>
                </div>
                <div className="ld-record-row ld-record-row-total">
                  <dt>Received</dt>
                  <dd>PHP 55,300.00</dd>
                </div>
                <div className="ld-record-row">
                  <dt>Approved by</dt>
                  <dd>Two named people</dd>
                </div>
                <div className="ld-record-row">
                  <dt>Settled</dt>
                  <dd>Final on Sui, time-stamped</dd>
                </div>
                <div className="ld-record-row">
                  <dt>Reference</dt>
                  <dd>Issued with the record</dd>
                </div>
              </div>
            </dl>
          </div>
        </section>

        <section id="calculator" className="ld-section" aria-labelledby="calculator-title">
          <div className="ld-shell">
            <h2 id="calculator-title">What it costs to send</h2>
            <p className="ld-lede">
              Splash prices one leg: US dollars to Philippine pesos. If you hold ringgit or another currency,
              you convert it to dollars at your own bank first, and that leg is not in these figures.
            </p>
            <FeeCalculator />
          </div>
        </section>

        <section id="how-it-works" className="ld-section" aria-labelledby="how-title">
          <div className="ld-shell">
            <h2 id="how-title">Three steps</h2>
            <ol className="ld-steps">
              <li>
                <h3>Fund in dollars</h3>
                <p>Fund the payment in US dollars, by bank transfer or card, and choose the supplier.</p>
              </li>
              <li>
                <h3>Approve it</h3>
                <p>
                  Review the quote and approve. You can require a second approver above an amount you set,
                  and the assistant can prepare the payment but never release it.
                </p>
              </li>
              <li>
                <h3>Paid in pesos, with the record</h3>
                <p>The supplier receives pesos through the local rail, and you both receive the record.</p>
              </li>
            </ol>
          </div>
        </section>

        <section id="numbers" className="ld-section" aria-labelledby="numbers-title">
          <div className="ld-shell">
            <h2 id="numbers-title">The figures, with their sources</h2>
            <ul className="ld-numbers">
              {numbers.map((entry) => (
                <li className="ld-number" key={entry.id}>
                  <strong>
                    {entry.value}
                    {entry.status !== 'verified' ? <span className="ld-number-flag">Needs verification</span> : null}
                  </strong>
                  <p>{entry.meaning}</p>
                  <small>
                    {entry.label}. Source:{' '}
                    <a className="ld-link" href={entry.sourceUrl} rel="noopener noreferrer">
                      {entry.source}
                    </a>
                    , as of {entry.asOf}.
                  </small>
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section id="pricing" className="ld-section" aria-labelledby="pricing-title">
          <div className="ld-shell">
            <h2 id="pricing-title">One price on one leg</h2>
            <div className="ld-price">
              <div>
                <strong>
                  {flatFee} + {margin}
                </strong>
                <p>of the amount, on the USD to PHP leg. Illustrative until your quote.</p>
              </div>
              <p>
                The exchange rate is quoted when you send and written on the record. No monthly fee, no fee to
                receive, and nothing charged on a payment that does not complete.
              </p>
              <p className="ld-price-note">
                {preview
                  ? 'Founding terms for the first fifty businesses are being set and are not published yet. This line renders in preview only.'
                  : 'Volume pricing is agreed per business. Ask us before you send.'}
              </p>
            </div>
          </div>
        </section>

        <section id="faq" className="ld-section" aria-labelledby="faq-title">
          <div className="ld-shell">
            <h2 id="faq-title">Asked before signing up</h2>
            <div className="ld-faq">
              {LANDING_FAQ.map((item) => (
                <details key={item.q}>
                  <summary>{item.q}</summary>
                  <p>{item.a}</p>
                </details>
              ))}
            </div>
          </div>
        </section>
      </main>

      <footer className="ld-footer">
        <div className="ld-shell ld-footer-grid">
          <div>
            <p>
              <strong>{BRAND.name}</strong>. Payments from US dollars to Philippine pesos, with a record for both
              sides.
            </p>
            <p>
              Sandbox on the Sui testnet. No customer funds move. Support:{' '}
              <a className="ld-link" href={`mailto:${BRAND.supportEmail}`}>
                {BRAND.supportEmail}
              </a>
            </p>
          </div>
          <nav aria-label="Footer">
            <a href="#how-it-works">How it works</a>
            <a href="#pricing">Pricing</a>
            <a href="#faq">Questions</a>
            <Link href="/trust">Trust and compliance</Link>
            <Link href="/login">Sign in</Link>
          </nav>
        </div>
        <div className="ld-shell ld-footer-bar">
          <span>{BRAND.copyright(year)}</span>
          <span>Splash is not yet a licensed money-services business.</span>
        </div>
      </footer>
    </div>
  );
}
