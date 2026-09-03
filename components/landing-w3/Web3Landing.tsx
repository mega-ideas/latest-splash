import { Archivo, Inter, JetBrains_Mono } from 'next/font/google';
import Link from 'next/link';

import { brand } from '@/lib/brand';
import { formatAmount, formatMoney } from '@/lib/money';
import { routeAlternatives } from '@/lib/payments/clearance';

import '@/styles/landing-w3.css';

import Nav from './Nav';
import { Counter, Flow, MotionReady, Reveal } from './motion';

const display = Archivo({ subsets: ['latin'], weight: ['600', '700'], variable: '--w3-display', display: 'swap' });
const sans = Inter({ subsets: ['latin'], variable: '--w3-sans', display: 'swap' });
const mono = JetBrains_Mono({ subsets: ['latin'], weight: ['400', '500'], variable: '--w3-mono', display: 'swap' });

const SEND_USD = 5000;

function ArrowRight() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2 8h11M9 4l4 4-4 4" />
    </svg>
  );
}

const CORRIDORS = [
  ['USD → PHP', 'Manila', 'live', 'Sandbox'],
  ['USD → IDR', 'Jakarta', 'staged', 'Partner controls in activation'],
  ['USD → MYR', 'Kuala Lumpur', 'modelled', 'Pricing modelled'],
  ['USD → SGD', 'Singapore', 'modelled', 'Pricing modelled'],
  ['USD → VND', 'Ho Chi Minh City', 'modelled', 'Pricing modelled'],
  ['USD → THB', 'Bangkok', 'modelled', 'Pricing modelled'],
] as const;

/**
 * Public landing, web3-native and light: bone canvas, near-black ink, one acid
 * signal spent on the things that matter (the primary action, the live route,
 * the selected row). Covers the three products by name — cross-border
 * payments, treasury and invoices — and keeps every claim inside the canon:
 * two corridors, licensed partners as the system of record, no funds held
 * until MFCA activation, comparison figures marked illustrative.
 */
export default function Web3Landing() {
  const comparison = routeAlternatives('PHP', SEND_USD);
  const partner = comparison.rows[0];
  const effective = partner.delivered / SEND_USD;

  return (
    <div className={`w3 ${display.variable} ${sans.variable} ${mono.variable}`}>
      <MotionReady />
      <Nav />

      <main id="main">
        {/* ── Hero ─────────────────────────────────────────────────────── */}
        <section className="w3-hero" aria-labelledby="hero-title">
          <div className="w3-hero__grid" aria-hidden="true" />
          <div className="wrap">
            <p className="w3-hero__eyebrow">
              <b>Sandbox</b> USD → PHP live · IDR staged
            </p>
            <h1 id="hero-title" className="display">
              <span className="line"><span style={{ '--i': 0 } as React.CSSProperties}>Send USD.</span></span>
              <span className="line"><span style={{ '--i': 1 } as React.CSSProperties}>Land local.</span></span>
              <span className="line"><span style={{ '--i': 2 } as React.CSSProperties}><em>Prove it.</em></span></span>
            </h1>
            <p className="lede w3-hero__lede">
              One control plane for cross-border payouts, treasury and invoices. Settlement on Sui reaches finality in about 400 milliseconds, licensed partners deliver into local rails, and every payment leaves a receipt that reconciles against your ledger.
            </p>
            <div className="w3-hero__cta">
              <Link href="/login" className="btn btn--aqua">Clear a payment <ArrowRight /></Link>
              <a href="#how" className="btn btn--ghost">See how it settles</a>
            </div>
            <p className="lbl w3-hero__note">No customer funds are held until MFCA activation · Licensed partners are the system of record</p>

            {/* Live instrument */}
            <article className="w3-instrument" aria-label={`Example payment: ${formatMoney('USD', SEND_USD)} from Kuala Lumpur to Manila`}>
              <div className="w3-instrument__bar">
                <span className="lbl">Clearance record · Supplier payout</span>
                <span className="w3-live">Live</span>
              </div>
              <div className="w3-instrument__body">
                <div className="w3-leg">
                  <span className="lbl">You send · KUL</span>
                  <span className="amt">{formatMoney('USD', SEND_USD)}</span>
                  <span className="who">Bank USD · held balance</span>
                </div>
                <div className="w3-track">
                  <div className="w3-track__rail" aria-hidden="true">
                    <svg viewBox="0 0 320 34" preserveAspectRatio="none">
                      <path className="draw" d="M6 24 C 80 24, 100 8, 160 8 C 220 8, 240 24, 314 24" fill="none" stroke="var(--aqua-600)" strokeWidth="1.5" pathLength={1} />
                      <circle className="pip" cx="6" cy="24" r="4" fill="var(--aqua-600)" />
                      <circle className="pip" cx="110" cy="11.5" r="4" fill="var(--aqua-600)" />
                      <circle className="pip" cx="210" cy="11.5" r="4" fill="var(--aqua-600)" />
                      <circle className="pip" cx="314" cy="24" r="4" fill="none" stroke="var(--aqua-600)" strokeWidth="1.5" />
                    </svg>
                  </div>
                  <ol className="w3-steps">
                    <li className="w3-step"><b>Beneficiary</b><span>Verified</span></li>
                    <li className="w3-step"><b>FX</b><span>Locked 30s</span></li>
                    <li className="w3-step"><b>Policy</b><span>Passed</span></li>
                    <li className="w3-step w3-step--wait"><b>Checker</b><span>Pending</span></li>
                  </ol>
                </div>
                <div className="w3-leg w3-leg--to">
                  <span className="lbl">They receive · MNL</span>
                  <span className="amt">{formatAmount('PHP', partner.delivered)}</span>
                  <span className="who">Licensed payout partner · PHP</span>
                </div>
              </div>
              <dl className="w3-instrument__foot">
                <div><dt className="lbl">All-in cost</dt><dd className="v">{formatMoney('USD', partner.feeUsd)} · {partner.feePct.toFixed(2)}%</dd></div>
                <div><dt className="lbl">Effective FX</dt><dd className="v">1 USD = {effective.toFixed(4)} PHP</dd></div>
                <div><dt className="lbl">Chain finality</dt><dd className="v">~400 ms on Sui</dd></div>
                <div><dt className="lbl">Delivery</dt><dd className="v">{partner.eta} · partner rail</dd></div>
              </dl>
            </article>
          </div>

          {/* Corridor marquee */}
          <div className="w3-marquee" aria-hidden="true">
            <div className="w3-marquee__track">
              {[0, 1].map((copy) => (
                <div className="w3-marquee__group" key={copy}>
                  {CORRIDORS.map(([code, city, state, note]) => (
                    <span className="w3-chip" key={`${copy}-${code}`}>
                      <i style={{ background: state === 'live' ? 'var(--aqua-600)' : state === 'staged' ? 'var(--warn)' : 'var(--line-strong)' }} />
                      {code}<em>{city} · {note}</em>
                    </span>
                  ))}
                </div>
              ))}
            </div>
          </div>
          <p className="sr-only">Corridors: USD to PHP live in sandbox, USD to IDR staged, and MYR, SGD, VND and THB modelled but not executable.</p>
        </section>

        {/* ── Three products ───────────────────────────────────────────── */}
        <section className="w3-section" aria-labelledby="products-title">
          <div className="wrap">
            <Reveal className="w3-head">
              <p className="lbl">One control plane</p>
              <h2 id="products-title" className="h2">Payouts, treasury and invoices stop being three systems.</h2>
              <p className="lede">The same balances, beneficiaries and policy serve all three. What you approve is what executes, and what executes is what reconciles.</p>
            </Reveal>

            <div className="w3-pillars">
              <Reveal as="article" className="w3-pillar" delay={0}>
                <span className="w3-pillar__n" id="payments">01 / Cross-border payments</span>
                <h3 className="h3">Send USD, land local currency</h3>
                <figure aria-hidden="true">
                  <svg viewBox="0 0 240 108">
                    <path d="M20 74 C 70 74, 80 34, 120 34 C 160 34, 172 74, 220 74" fill="none" stroke="var(--aqua-600)" strokeWidth="1.5" strokeDasharray="4 4" />
                    <circle cx="20" cy="74" r="6" fill="var(--aqua)" stroke="var(--ink)" strokeWidth="1.2" />
                    <circle cx="220" cy="74" r="6" fill="var(--paper)" stroke="var(--ink)" strokeWidth="1.2" />
                    <rect x="96" y="20" width="48" height="28" rx="3" fill="var(--paper)" stroke="var(--ink)" strokeWidth="1.2" />
                    <path d="M104 34h32M104 40h20" stroke="var(--ink-3)" strokeWidth="1.2" />
                  </svg>
                </figure>
                <ul>
                  <li>Quote, policy check and approval before any money moves</li>
                  <li>Routes compared on delivered amount, cost and time</li>
                  <li>Delivery by a licensed payout partner into the local rail</li>
                </ul>
                <Link href="/login">Clear a payment <ArrowRight /></Link>
              </Reveal>

              <Reveal as="article" className="w3-pillar" delay={90}>
                <span className="w3-pillar__n" id="treasury">02 / Treasury</span>
                <h3 className="h3">See what is available before you commit</h3>
                <figure aria-hidden="true">
                  <svg viewBox="0 0 240 108">
                    {[[36, 44], [76, 30], [116, 56], [156, 22], [196, 38]].map(([x, h]) => (
                      <rect key={x} x={x} y={80 - h} width="22" height={h} rx="2" fill={x === 156 ? 'var(--aqua)' : 'var(--paper)'} stroke="var(--ink)" strokeWidth="1.2" />
                    ))}
                    <path d="M20 80h204" stroke="var(--ink)" strokeWidth="1.2" />
                  </svg>
                </figure>
                <ul>
                  <li>Available, reserved and in-flight balances in one register</li>
                  <li>Truthful asset labels: USDC, USD claim, USDY</li>
                  <li>Every move becomes a proposal for a checker</li>
                </ul>
                <Link href="/login">Open the liquidity view <ArrowRight /></Link>
              </Reveal>

              <Reveal as="article" className="w3-pillar" delay={180}>
                <span className="w3-pillar__n" id="invoices">03 / Invoices</span>
                <h3 className="h3">From invoice to settled receipt</h3>
                <figure aria-hidden="true">
                  <svg viewBox="0 0 240 108">
                    <rect x="70" y="16" width="70" height="76" rx="3" fill="var(--paper)" stroke="var(--ink)" strokeWidth="1.2" />
                    <path d="M82 34h46M82 46h46M82 58h30" stroke="var(--ink-3)" strokeWidth="1.2" />
                    <rect x="126" y="52" width="44" height="30" rx="3" fill="var(--aqua)" stroke="var(--ink)" strokeWidth="1.2" />
                    <path d="M136 67l6 6 12-12" fill="none" stroke="var(--ink)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </figure>
                <ul>
                  <li>Issue and track invoices against the payer organisation</li>
                  <li>Payment references carried through to the payout</li>
                  <li>Three-way match closes the invoice with its evidence</li>
                </ul>
                <Link href="/login">Review invoices <ArrowRight /></Link>
              </Reveal>
            </div>
          </div>
        </section>

        {/* ── How it clears (dark) ─────────────────────────────────────── */}
        <section id="how" className="pool w3-section" aria-labelledby="how-title">
          <div className="wrap">
            <Reveal className="w3-head">
              <p className="lbl">How it clears</p>
              <h2 id="how-title" className="h2">Observe. Clear. Prove.</h2>
              <p className="lede">Three stages, each one a gate. The interface shows the outcome; the server decides it.</p>
            </Reveal>
            <Flow>
              <li className="w3-stage">
                <span className="w3-stage__dot" style={{ '--delay': '0ms' } as React.CSSProperties}>01</span>
                <h3 className="h3">Observe real conditions</h3>
                <p className="body">Balances, beneficiary verification, live FX, limits and partner health, read from the systems of record rather than typed in.</p>
              </li>
              <li className="w3-stage">
                <span className="w3-stage__dot" style={{ '--delay': '400ms' } as React.CSSProperties}>02</span>
                <h3 className="h3">Clear the compliant path</h3>
                <p className="body">Eligible routes compared on delivered amount, cost, time and policy outcome. A maker builds it, a distinct checker approves it, and only then does it execute.</p>
              </li>
              <li className="w3-stage">
                <span className="w3-stage__dot" style={{ '--delay': '800ms' } as React.CSSProperties}>03</span>
                <h3 className="h3">Prove final settlement</h3>
                <p className="body">Partner confirmation, internal ledger and on-chain receipt matched to one outcome. Anything that does not match becomes an exception with the difference named.</p>
              </li>
            </Flow>
          </div>
        </section>

        {/* ── Route comparison ─────────────────────────────────────────── */}
        <section className="w3-section" aria-labelledby="routes-title">
          <div className="wrap">
            <Reveal className="w3-head">
              <p className="lbl">Route comparison</p>
              <h2 id="routes-title" className="h2">One recommendation, every alternative attached.</h2>
              <p className="lede">The same {formatMoney('USD', SEND_USD)} to Manila across the routes we can price. The partner rail is the executable one; the others are reviewed category baselines, shown so the recommendation never arrives alone.</p>
            </Reveal>
            <Reveal className="w3-compare">
              <div className="w3-scroll">
                <table className="w3-table">
                  <caption className="sr-only">Illustrative route comparison for USD 5,000.00 to PHP</caption>
                  <thead>
                    <tr>
                      <th scope="col">Route</th>
                      <th scope="col" className="n">They receive</th>
                      <th scope="col" className="n">All-in cost</th>
                      <th scope="col" className="n">Delivery</th>
                      <th scope="col">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {comparison.rows.map((row) => (
                      <tr key={row.id} className={row.recommended ? 'best' : undefined}>
                        <td>{row.route}</td>
                        <td className="n">{formatAmount('PHP', row.delivered)}</td>
                        <td className="n">{formatMoney('USD', row.feeUsd)} <span className="lbl">({row.feePct.toFixed(2)}%)</span></td>
                        <td className="n">{row.eta}</td>
                        <td>{row.recommended ? <span className="w3-tag w3-tag--ok">Executable</span> : <span className="w3-tag w3-tag--muted">Baseline</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Reveal>
            <p className="lbl" style={{ marginTop: 14 }}>Illustrative · sandbox pricing · bank and money-transfer rows are reviewed category baselines, not live quotes</p>
          </div>
        </section>

        {/* ── Proof band (dark) ────────────────────────────────────────── */}
        <section id="proof" className="pool w3-section" aria-labelledby="proof-title">
          <div className="wrap">
            <Reveal className="w3-head">
              <p className="lbl">On-chain proof</p>
              <h2 id="proof-title" className="h2">A receipt you can check without asking us.</h2>
              <p className="lede">Settlement is a transaction on Sui, and its digest, content hashes and amounts are anchored to public storage. Counterparty and partner detail stays off the public record.</p>
            </Reveal>
            <div className="w3-proof__grid">
              <Reveal className="w3-receipt">
                <div className="w3-receipt__bar">
                  <span className="lbl">Settlement receipt</span>
                  <span className="lbl">Sui · mainnet</span>
                </div>
                <dl>
                  <div className="row"><dt className="lbl">Digest</dt><dd className="aq">7Yb4…qF2s9Vt1kP</dd></div>
                  <div className="row"><dt className="lbl">Amount</dt><dd>{formatMoney('USD', SEND_USD)} → {formatAmount('PHP', partner.delivered)}</dd></div>
                  <div className="row"><dt className="lbl">Finality</dt><dd>~400 ms</dd></div>
                  <div className="row"><dt className="lbl">Evidence blob</dt><dd>walrus://0x8c…a41f</dd></div>
                  <div className="row"><dt className="lbl">Audit anchor</dt><dd>anchored · content hash matched</dd></div>
                  <div className="row"><dt className="lbl">Reconciliation</dt><dd className="aq">partner · ledger · chain matched</dd></div>
                </dl>
              </Reveal>
              <Reveal className="w3-facts" delay={120}>
                <div className="w3-fact">
                  <span className="num"><Counter value={400} suffix=" ms" /></span>
                  <p className="body">Typical time to finality on Sui. Delivery into the local rail follows the partner&apos;s own schedule.</p>
                </div>
                <div className="w3-fact">
                  <span className="num"><Counter value={3} /></span>
                  <p className="body">Records matched on every payment: partner confirmation, internal ledger and the on-chain receipt.</p>
                </div>
                <div className="w3-fact">
                  <span className="num"><Counter value={0} /></span>
                  <p className="body">Customer funds held. Splash orchestrates; licensed partners hold and move the money until MFCA activation.</p>
                </div>
              </Reveal>
            </div>
          </div>
        </section>

        {/* ── Developers ───────────────────────────────────────────────── */}
        <section id="developers" className="w3-section" aria-labelledby="dev-title">
          <div className="wrap">
            <Reveal className="w3-head">
              <p className="lbl">Developers</p>
              <h2 id="dev-title" className="h2">Same record in the API as on the screen.</h2>
              <p className="lede">Signed requests, idempotency keys, verifiable webhooks and a sandbox that reproduces quote expiry, policy blocks and reconciliation breaks.</p>
            </Reveal>
            <div className="w3-dev">
              <Reveal className="w3-code" as="div">
                <pre tabIndex={0} style={{ margin: 0 }}>
                  <b>POST</b> /api/transfers/authorize{'\n'}
                  <i>Idempotency-Key: 8f0b4e2a-…</i>{'\n\n'}
                  {`{
  "recipient": { "name": "Manila Textiles", "country": "PH" },
  "amount":    { "value": "5000.00", "targetCurrency": "PHP" },
  "fundingSelection": { "type": "held", "source": "SPLASH_BALANCE" }
}`}
                  {'\n\n'}
                  <b>202</b> Accepted{'\n'}
                  {`{ "state": "AWAITING_CHECKER", "proposalId": "prp_…", "approvalHash": "0x…" }`}
                </pre>
              </Reveal>
              <Reveal as="div" delay={100}>
                <ul className="w3-devlist">
                  <li><b>Webhooks you can verify</b><span>Every event is signed. Replay it against the clearance record to check the state you hold.</span></li>
                  <li><b>Sandbox that behaves</b><span>Quote expiry, policy blocks, partner exceptions and mismatches are all reproducible.</span></li>
                  <li><b>Evidence bundle</b><span>Digest, content hashes, amounts and timeline, exportable per payment.</span></li>
                  <li><b><Link href="/docs">Read the API docs</Link></b><span>Endpoints, webhook schemas and sandbox scenarios.</span></li>
                </ul>
              </Reveal>
            </div>
          </div>
        </section>

        {/* ── CTA ──────────────────────────────────────────────────────── */}
        <section className="w3-cta" aria-labelledby="cta-title">
          <div className="wrap">
            <div>
              <p className="lbl">Sandbox open</p>
              <h2 id="cta-title" className="h2" style={{ marginTop: 12 }}>Clear your first corridor.</h2>
              <p className="body" style={{ color: 'var(--ink)', marginTop: 10 }}>Real routes, sandbox pricing and a real receipt in minutes.</p>
            </div>
            <div className="w3-cta__actions">
              <Link href="/sandbox" className="btn btn--ink">Open sandbox <ArrowRight /></Link>
              <a href={`mailto:${brand.supportEmail}`} className="btn btn--ghost" style={{ borderColor: 'var(--ink)' }}>Talk to our team</a>
            </div>
          </div>
        </section>
      </main>

      {/* ── Footer ─────────────────────────────────────────────────────── */}
      <footer className="w3-footer">
        <div className="wrap">
          <div className="w3-footer__grid">
            <div className="w3-footer__brand">
              <span className="w3-mark"><i aria-hidden="true" />Splash</span>
              <p>{brand.postureLine}</p>
              <p>Licensed partners are the system of record for regulated activity today. Labuan FSA licensing in process; BNM MSB and BSP planned.</p>
            </div>
            {([
              ['Product', [['Cross-border payments', '#payments'], ['Treasury', '#treasury'], ['Invoices', '#invoices'], ['Pricing', '/pricing'], ['Rates', '/rates']]],
              ['Network', [['Corridors', '/rates'], ['Proof', '#proof'], ['Status', '/metrics']]],
              ['Developers', [['API docs', '/docs'], ['Sandbox', '/sandbox'], ['Changelog', '/roadmap']]],
              ['Company', [['Trust & compliance', '/trust'], ['Roadmap', '/roadmap'], ['Support', `mailto:${brand.supportEmail}`]]],
            ] as [string, [string, string][]][]).map(([title, links]) => (
              <nav key={title} aria-label={title}>
                <h3>{title}</h3>
                <ul>
                  {links.map(([label, href]) => (
                    <li key={label}><Link href={href}>{label}</Link></li>
                  ))}
                </ul>
              </nav>
            ))}
          </div>
          <div className="w3-footer__bottom">
            <span>{brand.copyright}</span>
            <span>Sandbox · no customer funds until MFCA activation</span>
          </div>
        </div>
      </footer>
    </div>
  );
}
