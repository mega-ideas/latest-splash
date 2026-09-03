import { IBM_Plex_Mono, Inter } from 'next/font/google';
import Link from 'next/link';

import { brand } from '@/lib/brand';

import '@/styles/landing-v4.css';

import LandingHeader from './LandingHeader';

const inter = Inter({ subsets: ['latin'], variable: '--lv4-sans', display: 'swap' });
const plexMono = IBM_Plex_Mono({ subsets: ['latin'], weight: ['400', '500'], variable: '--lv4-mono', display: 'swap' });

const REF = 'SPL-7X0MCC1-0001847';

function Arrow() {
  return (
    <svg viewBox="0 0 22 12" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6">
      <path d="M0 6h20M15 1l5 5-5 5" />
    </svg>
  );
}

function Plane({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true" fill="currentColor">
      <path d="M21 16v-2l-8-5V3.5a1.5 1.5 0 0 0-3 0V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5l8 2.5Z" />
    </svg>
  );
}

/**
 * Marketing landing — an exact port of the Clearance Signal handoff mockup
 * (00-landing-page-full.png): its palette (midnight, mineral, signal),
 * its type (Inter / IBM Plex Mono), its sections and its figures, all built
 * as real HTML and SVG. The palette is scoped to this page.
 */
export default function MarketingLanding() {
  return (
    <div className={`lv4 ${inter.variable} ${plexMono.variable}`}>
      <LandingHeader />
      <main id="main">
        {/* Hero */}
        <section className="lv4-hero" aria-labelledby="hero-title">
          <div className="wrap">
            <div className="lv4-hero__grid">
              <div>
                <h1 id="hero-title">Global payments, cleared for landing.</h1>
                <p className="lv4-hero__lede">One control plane to verify, price, approve, route and reconcile every cross-border payment.</p>
                <div className="lv4-hero__actions">
                  <Link href="/login" className="btn btn--midnight">Clear a payment <Arrow /></Link>
                  <a href="#platform" className="btn btn--outline">See how it works</a>
                </div>
              </div>
              <div className="lv4-hero__side">
                <div className="lv4-control" aria-label="Splash clearance control">
                  <div className="lv4-control__title">Splash clearance control</div>
                  <div><span>Control plane ID: </span><b>SPL-7X9M-CC1</b></div>
                  <div><span>Date: </span><b>15 May 2025 &nbsp; 09:41:22 UTC</b></div>
                  <div><span>Status: </span><b className="verified">Operational</b></div>
                </div>
                <svg className="lv4-stamp" viewBox="0 0 160 160" aria-label="Global payments, cleared for landing — Splash control plane" role="img">
                  <defs>
                    <path id="lv4-stamp-arc" d="M80 80 m-58 0 a58 58 0 1 1 116 0 a58 58 0 1 1 -116 0" />
                  </defs>
                  <circle cx="80" cy="80" r="76" fill="none" stroke="currentColor" strokeWidth="2" />
                  <circle cx="80" cy="80" r="70" fill="none" stroke="currentColor" strokeWidth="1" strokeDasharray="2 3" />
                  <circle cx="80" cy="80" r="46" fill="none" stroke="currentColor" strokeWidth="1.5" />
                  <text fontFamily="var(--mono)" fontSize="9.5" letterSpacing="2.2" fill="currentColor">
                    <textPath href="#lv4-stamp-arc" startOffset="2%">GLOBAL PAYMENTS</textPath>
                  </text>
                  <text fontFamily="var(--mono)" fontSize="9.5" letterSpacing="2.2" fill="currentColor">
                    <textPath href="#lv4-stamp-arc" startOffset="49%">CLEARED FOR LANDING</textPath>
                  </text>
                  <text x="80" y="78" textAnchor="middle" fontFamily="var(--sans)" fontSize="20" fontWeight="600" letterSpacing="-0.8" fill="currentColor">splash</text>
                  <text x="80" y="94" textAnchor="middle" fontFamily="var(--mono)" fontSize="7" letterSpacing="1.5" fill="currentColor">CONTROL</text>
                  <text x="80" y="104" textAnchor="middle" fontFamily="var(--mono)" fontSize="7" letterSpacing="1.5" fill="currentColor">PLANE</text>
                </svg>
              </div>
            </div>

            <article className="lv4-strip" aria-label="Example cross-border payment clearance">
              <div className="lv4-strip__head">
                <span className="label">Payment clearance strip</span>
                <span className="label">Clearance ref: SPL-7X0MCC1-20250515-004122</span>
              </div>
              <div className="lv4-strip__body">
                <div className="lv4-city">
                  <span className="label">Origin</span>
                  <span className="code">LON</span>
                  <span className="name">London, GB</span>
                </div>
                <div className="lv4-money">
                  <span className="label">You send</span>
                  <span className="amount">GBP 44,820.00</span>
                  <span className="acct">HSBC UK · GBP Account</span>
                </div>
                <div className="lv4-route">
                  <div className="lv4-route__line" aria-hidden="true"><Plane /></div>
                  <ol className="lv4-checkpoints" aria-label="Checkpoints">
                    <li className="lv4-checkpoint"><span className="t"><span className="n">1</span>Beneficiary</span><span className="s verified">Verified</span></li>
                    <li className="lv4-checkpoint"><span className="t"><span className="n">2</span>FX</span><span className="s verified">Locked</span></li>
                    <li className="lv4-checkpoint"><span className="t"><span className="n">3</span>Policy</span><span className="s verified">Passed</span></li>
                    <li className="lv4-checkpoint lv4-checkpoint--pending"><span className="t"><span className="n">4</span>Checker</span><span className="s signal">Pending</span></li>
                  </ol>
                </div>
                <div className="lv4-money lv4-money--to">
                  <span className="label">They receive</span>
                  <span className="amount">MYR 263,482.00</span>
                  <span className="acct">Public Bank · MYR Account</span>
                </div>
                <div className="lv4-city lv4-city--to">
                  <span className="label">Destination</span>
                  <span className="code">KUL</span>
                  <span className="name">Kuala Lumpur, MY</span>
                </div>
              </div>
              <dl className="lv4-strip__foot">
                <div><dt className="label">All-in cost</dt><dd className="v">GBP 62.74</dd></div>
                <div><dt className="label">Effective FX</dt><dd className="v">1 GBP = 5.8742 MYR</dd></div>
                <div><dt className="label">ETA</dt><dd className="v">Same day by 16:30 MYT</dd></div>
                <div><dt className="label">Payment ID</dt><dd className="v">SPL-7X0MCC1-0001B47</dd></div>
                <div><dt className="label">Last updated</dt><dd className="v" style={{ display: 'flex', justifyContent: 'space-between', gap: '0.75rem' }}><span>09:41:22 UTC</span><span className="lv4-live">Live</span></dd></div>
              </dl>
            </article>
          </div>
        </section>

        {/* Stats band */}
        <section className="lv4-stats" aria-label="Key indicators" style={{ marginTop: '1.5rem' }}>
          <div className="wrap">
            <div className="lv4-stat">
              <svg viewBox="0 0 44 44" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden="true"><circle cx="22" cy="22" r="16" /><ellipse cx="22" cy="22" rx="7" ry="16" /><path d="M6 22h32M9 13h26M9 31h26" /></svg>
              <span className="big">14</span>
              <span><span className="t">regulated corridors</span><br /><span className="d">Live coverage across APAC, EMEA, Americas</span></span>
            </div>
            <div className="lv4-stat">
              <svg viewBox="0 0 44 44" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden="true"><path d="M22 8 6 16l16 8 16-8-16-8Z" /><path d="m6 22 16 8 16-8M6 28l16 8 16-8" /></svg>
              <span className="big">6</span>
              <span><span className="t">evidence layers</span><br /><span className="d">Every decision with verifiable proof</span></span>
            </div>
            <div className="lv4-stat">
              <svg viewBox="0 0 44 44" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden="true"><circle cx="22" cy="22" r="16" /><path d="m14 22 5 5 11-11" /></svg>
              <span className="big">99.98%</span>
              <span><span className="t">auto-reconciled</span><br /><span className="d">Three-way match to final settlement</span></span>
            </div>
            <div className="lv4-stat">
              <svg viewBox="0 0 44 44" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden="true"><path d="M22 6 8 11v10c0 8 6 14 14 17 8-3 14-9 14-17V11L22 6Z" /><path d="m15 22 5 5 9-9" /></svg>
              <span className="big">24/7</span>
              <span><span className="t">policy enforcement</span><br /><span className="d">Server-enforced controls, no manual bypass</span></span>
            </div>
          </div>
        </section>

        {/* Traffic control */}
        <section className="lv4-section" aria-labelledby="traffic-control-title">
          <div className="wrap lv4-traffic">
            <div>
              <h2 id="traffic-control-title" className="lv4-h2">Payments don’t need another rail. They need traffic control.</h2>
              <p className="lv4-copy">Splash operates the control plane above banks, payment providers, FX venues and local payout rails.</p>
              <p className="lv4-copy">We observe real conditions, clear the best compliant path and prove final settlement.</p>
            </div>
            <div>
              <ol className="lv4-steps">
                <li className="lv4-step"><span className="k"><b>01</b>Observe real conditions</span><span className="d">Live FX, fees, limits, health, compliance and liquidity.</span></li>
                <li className="lv4-step"><span className="k"><b>02</b>Clear the best compliant path</span><span className="d">Policy-aware route selection with full approval.</span></li>
                <li className="lv4-step"><span className="k"><b>03</b>Prove final settlement</span><span className="d">Three-way reconciliation and immutable audit evidence.</span></li>
              </ol>
              <figure className="lv4-diagram" aria-label="Route intelligence: London to Kuala Lumpur across five candidate routes, regulated partner rail selected">
                <svg viewBox="0 0 980 240" role="img" aria-hidden="true">
                  <g fontFamily="var(--mono)" fontSize="11" fill="var(--slate-500)">
                    <text x="36" y="118" fontFamily="var(--sans)" fontSize="26" fontWeight="600" fill="var(--slate-950)">LON</text>
                    <text x="36" y="136">GB</text>
                    <text x="900" y="118" fontFamily="var(--sans)" fontSize="26" fontWeight="600" fill="var(--slate-950)">KUL</text>
                    <text x="900" y="136">MY</text>
                  </g>
                  {[
                    ['Regulated partner rail', 60, true],
                    ['Bank SWIFT', 100, false],
                    ['Direct local payout', 140, false],
                    ['Card network', 180, false],
                    ['Digital partner', 220, false],
                  ].map(([name, y, on]) => (
                    <g key={String(name)}>
                      <path d={`M118 156 C 260 156, 300 ${y}, 420 ${y} L 560 ${y} C 680 ${y}, 720 156, 860 156`} fill="none" stroke={on ? 'var(--signal-500)' : 'var(--slate-300)'} strokeWidth={on ? 1.6 : 1} strokeDasharray={on ? undefined : '3 4'} />
                      <circle cx="420" cy={Number(y)} r="4" fill={on ? 'var(--signal-500)' : 'var(--mineral-100)'} stroke={on ? 'var(--signal-500)' : 'var(--slate-300)'} strokeWidth="1.2" />
                      <circle cx="560" cy={Number(y)} r="4" fill={on ? 'var(--signal-500)' : 'var(--mineral-100)'} stroke={on ? 'var(--signal-500)' : 'var(--slate-300)'} strokeWidth="1.2" />
                      <text x="440" y={Number(y) + 4} fontFamily="var(--mono)" fontSize="11" fill={on ? 'var(--slate-950)' : 'var(--slate-500)'}>{String(name)}</text>
                    </g>
                  ))}
                  {[[190, 128], [330, 60], [650, 60], [790, 128]].map(([x, y]) => (
                    <rect key={`${x}-${y}`} x={x - 5} y={y - 5} width="10" height="10" fill="var(--signal-500)" transform={`rotate(45 ${x} ${y})`} />
                  ))}
                  <circle cx="118" cy="156" r="7" fill="var(--mineral-100)" stroke="var(--slate-950)" strokeWidth="1.5" />
                  <circle cx="860" cy="156" r="7" fill="var(--mineral-100)" stroke="var(--slate-950)" strokeWidth="1.5" />
                </svg>
                <figcaption className="lv4-diagram__foot"><span className="label">Origin</span><span className="label">Route intelligence</span><span className="label">Destination</span></figcaption>
              </figure>
            </div>
          </div>
        </section>

        {/* Route comparison */}
        <section id="platform" className="dark lv4-section" aria-labelledby="decision-title">
          <div className="wrap lv4-compare">
            <div>
              <h2 id="decision-title" className="lv4-h2">One decision. Every reason attached.</h2>
              <p className="lv4-copy">Route comparison in real time. Policy, compliance, cost and execution probability—side by side.</p>
              <div className="lv4-refbox">
                <div><div className="label">Reference</div><div>{REF}</div></div>
                <div><div className="label">Evaluated</div><div>15 May 2025 09:41:22 UTC</div></div>
              </div>
            </div>
            <div className="lv4-panel">
              <div className="lv4-panel__head"><span className="label">Route comparison</span><span className="label">Live pricing &nbsp;09:41:22 UTC <span className="verified">●</span></span></div>
              <div className="lv4-compare__grid">
                <div className="lv4-tablewrap">
                  <table className="lv4-table">
                    <caption className="sr-only">Route comparison for GBP 44,820.00 to MYR</caption>
                    <thead>
                      <tr>
                        <th scope="col"><span className="sr-only">Attribute</span></th>
                        <th scope="col"><span className="icon" aria-hidden="true">★</span>Regulated partner rail<span className="sub">Licensed PSP Corridor</span></th>
                        <th scope="col"><span className="icon" aria-hidden="true">▤</span>Bank SWIFT<span className="sub">Via Correspondent Bank</span></th>
                        <th scope="col"><span className="icon" aria-hidden="true">✦</span>Direct local payout<span className="sub">Local Settlement Partner</span></th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr><td className="rowlabel">You send</td><td className="mono">GBP 44,820.00</td><td className="mono">GBP 44,820.00</td><td className="mono">GBP 44,820.00</td></tr>
                      <tr><td className="rowlabel">They receive (est.)</td><td className="mono">MYR 263,482.00</td><td className="mono">MYR 263,482.00</td><td className="mono">MYR 263,420.00</td></tr>
                      <tr><td className="rowlabel">All-in cost</td><td className="mono">GBP 62.74</td><td className="mono">GBP 112.46</td><td className="mono">GBP 71.18</td></tr>
                      <tr><td className="rowlabel">Effective FX</td><td className="mono">1 GBP = 5.8742 MYR</td><td className="mono">1 GBP = 5.7689 MYR</td><td className="mono">1 GBP = 5.8421 MYR</td></tr>
                      <tr><td className="rowlabel">ETA</td><td className="mono">Same day by 16:30 MYT</td><td className="mono">1 business day</td><td className="mono">Same day by 18:00 MYT</td></tr>
                      <tr><td className="rowlabel">Confidence</td><td className="mono">98.6%<span className="lv4-bar"><i style={{ width: '98.6%' }} /></span></td><td className="mono">92.1%<span className="lv4-bar"><i style={{ width: '92.1%' }} /></span></td><td className="mono">95.3%<span className="lv4-bar"><i style={{ width: '95.3%' }} /></span></td></tr>
                      <tr><td className="rowlabel">Policy result</td><td className="mono verified">PASSED</td><td className="mono attention">PASSED WITH REVIEW</td><td className="mono verified">PASSED</td></tr>
                      <tr><td className="rowlabel">Source freshness</td><td className="mono">30s ago</td><td className="mono">45s ago</td><td className="mono">20s ago</td></tr>
                      <tr><td className="rowlabel">Select route</td><td><Link href="/login" className="btn btn--signal btn--sm">Select this route <Arrow /></Link></td><td><span className="btn btn--outline-light btn--sm" aria-disabled="true">Select route</span></td><td><span className="btn btn--outline-light btn--sm" aria-disabled="true">Select route</span></td></tr>
                    </tbody>
                  </table>
                </div>
                <aside className="lv4-why" aria-label="Why this route">
                  <span className="label" style={{ color: 'var(--on-dark)' }}>Why this route</span>
                  <ul>
                    <li>Lowest all-in cost</li>
                    <li>Highest delivered amount</li>
                    <li>Same day settlement</li>
                    <li>Strong payout health</li>
                    <li>Policy auto-approved</li>
                  </ul>
                </aside>
              </div>
            </div>
          </div>
        </section>

        {/* Corridor atlas */}
        <section id="network" className="lv4-section" aria-labelledby="network-title">
          <div className="wrap lv4-atlas">
            <div>
              <p className="lv4-eyebrow">Corridor atlas</p>
              <h2 id="network-title" className="lv4-h2">Clear visibility. Global coverage.</h2>
              <p className="lv4-copy">Route comparator intelligence across major financial centers and payout markets.</p>
              <ul className="lv4-legend">
                <li><i /> High availability (&gt;98%)</li>
                <li><i className="dot" /> Moderate (95–98%)</li>
                <li><i className="bad" /> Constrained (&lt;95%)</li>
              </ul>
            </div>
            <figure className="lv4-map" aria-label="Corridor map: London, Singapore, Kuala Lumpur, Manila, Jakarta and Sydney">
              <svg viewBox="0 0 640 300" role="img" aria-hidden="true">
                <g fill="none" strokeWidth="1.4">
                  <path d="M60 70 C 220 40, 330 40, 470 120" stroke="var(--verified-600)" />
                  <path d="M60 70 C 240 60, 330 60, 380 80" stroke="var(--verified-600)" />
                  <path d="M60 70 C 250 100, 350 120, 530 130" stroke="var(--verified-600)" strokeDasharray="2 4" />
                  <path d="M60 70 C 240 160, 360 190, 470 210" stroke="var(--verified-600)" strokeDasharray="2 4" />
                  <path d="M60 70 C 200 220, 380 260, 555 250" stroke="var(--exception-600)" strokeDasharray="2 4" />
                  <path d="M380 80 L 470 120" stroke="var(--verified-600)" />
                  <path d="M380 80 C 430 90, 500 110, 530 130" stroke="var(--verified-600)" strokeDasharray="2 4" />
                  <path d="M470 120 L 470 210" stroke="var(--verified-600)" strokeDasharray="2 4" />
                  <path d="M470 120 C 520 160, 550 200, 555 250" stroke="var(--exception-600)" strokeDasharray="2 4" />
                </g>
                {[
                  ['LONDON', 'GB', 60, 70, true],
                  ['SINGAPORE', 'SG', 380, 80, false],
                  ['KUALA LUMPUR', 'MY', 470, 120, false],
                  ['MANILA', 'PH', 530, 130, false],
                  ['JAKARTA', 'ID', 470, 210, false],
                  ['SYDNEY', 'AU', 555, 250, false],
                ].map(([city, cc, x, y, origin]) => (
                  <g key={String(city)}>
                    <circle cx={Number(x)} cy={Number(y)} r="8" fill="var(--mineral-50)" stroke="var(--slate-950)" strokeWidth="1.4" />
                    <circle cx={Number(x)} cy={Number(y)} r="3" fill={origin ? 'var(--signal-500)' : 'var(--slate-950)'} />
                    <text x={Number(x)} y={Number(y) - 16} textAnchor="middle" fontFamily="var(--sans)" fontSize="11" fontWeight="600" fill="var(--slate-950)">{String(city)}</text>
                    <text x={Number(x)} y={Number(y) + 22} textAnchor="middle" fontFamily="var(--mono)" fontSize="9" fill="var(--slate-500)">{String(cc)}</text>
                  </g>
                ))}
              </svg>
            </figure>
            <div>
              <table className="lv4-mini">
                <caption className="sr-only">Corridor availability and payout health</caption>
                <thead><tr><th scope="col">Corridor</th><th scope="col">Availability</th><th scope="col">Payout health</th></tr></thead>
                <tbody>
                  {[
                    ['LON → KUL', '99.4%', 'Excellent'],
                    ['LON → SIN', '99.7%', 'Excellent'],
                    ['LON → MNL', '97.6%', 'Good'],
                    ['LON → JKT', '96.1%', 'Good'],
                    ['LON → SYD', '98.3%', 'Excellent'],
                    ['SIN → KUL', '99.6%', 'Excellent'],
                    ['SIN → MNL', '96.2%', 'Good'],
                    ['KUL → JKT', '97.0%', 'Good'],
                    ['KUL → SYD', '95.3%', 'Moderate'],
                  ].map(([c, a, h]) => (
                    <tr key={c}><td>{c}</td><td>{a}</td><td className={h === 'Moderate' ? 'attention' : 'verified'}>{h}</td></tr>
                  ))}
                </tbody>
              </table>
              <p className="lv4-mini__foot">Coverage as of 15 May 2025 09:41 UTC</p>
            </div>
          </div>
        </section>

        {/* Policy · clearance record · reconciliation */}
        <section id="security" className="dark" aria-labelledby="policy-title">
          <div className="wrap lv4-gov" style={{ paddingInline: 0 }}>
            <div>
              <h2 id="policy-title" className="lv4-h2">Policy travels with the payment.</h2>
              <p className="lv4-copy">Server-enforced governance at every checkpoint.</p>
              <ul className="lv4-controls">
                {[
                  ['Maker checker', 'Dual control required', 'M4 12h16M12 4v16'],
                  ['Beneficiary verification', 'Tax, sanctions and screening', 'M12 3l8 4v5c0 5-4 8-8 9-4-1-8-4-8-9V7l8-4z'],
                  ['Transaction monitoring', 'Structured and risk scoring', 'M3 17l5-6 4 3 5-8 4 5'],
                  ['Limits & anti-fraud', 'Concentration and purpose', 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 8v5l3 2'],
                  ['Roles & segregation', 'Least privilege access', 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0'],
                  ['Audit evidence', 'Immutable event log', 'M6 3h9l5 5v13H6zM14 3v6h6'],
                ].map(([t, d, path]) => (
                  <li key={t}>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true"><path d={path} /></svg>
                    <div>{t}<span>{d}</span></div>
                  </li>
                ))}
              </ul>
            </div>
            <div className="lv4-record">
              <span className="label" style={{ color: 'var(--on-dark)' }}>Clearance record</span>
              <span className="lv4-record__id">{REF}</span>
              <ol className="lv4-timeline">
                {[
                  ['09:31:11', 'Maker created payment', 'user@acme.finance.com'],
                  ['09:37:08', 'Beneficiary verified', 'meridian.components confirmed'],
                  ['09:37:24', 'Screening passed', 'sanctions, PEP, adverse media'],
                  ['09:38:31', 'Policy passed', 'limits, purpose, corridor rules'],
                  ['09:39:02', 'Checker approved', 'approver@acme.com'],
                  ['09:40:05', 'Payment released', 'to regulated partner rail'],
                ].map(([time, t, d]) => (
                  <li key={time} className="done"><span>{time}</span><div><b>{t}</b><span>{d}</span></div></li>
                ))}
                <li><span /><div><b>All controls satisfied</b><span>No overrides · No breaks</span></div></li>
              </ol>
            </div>
            <div className="lv4-recon">
              <div className="lv4-recon__head">
                <div>
                  <h2 className="lv4-h2" id="reconciliation-title">Three records enter. One truth leaves.</h2>
                  <p className="lv4-copy">We match partner confirmation, our ledger and network receipt to a single outcome.</p>
                </div>
                <div className="lv4-keys" aria-hidden="true">
                  <span><i style={{ background: 'var(--verified-600)' }} />Matched</span>
                  <span><i style={{ background: 'var(--signal-500)' }} />Exception</span>
                  <span><i style={{ background: 'var(--slate-300)' }} />Pending</span>
                </div>
              </div>
              <div className="lv4-recon__scroll">
              <table>
                <caption className="sr-only">Three-way reconciliation</caption>
                <thead><tr><th scope="col">Time (UTC)</th><th scope="col">Partner confirmation</th><th scope="col">Internal ledger</th><th scope="col">Network receipt</th><th scope="col">Match status</th></tr></thead>
                <tbody>
                  <tr><td>09:41:02</td><td>RCVD-PRT-8839221</td><td>LED-ACME-77122</td><td>NET-AE10-992321</td><td className="verified">✓ Matched</td></tr>
                  <tr><td>09:41:15</td><td>RCVD-PRT-8839222</td><td>LED-ACME-77123</td><td>NET-AE10-992322</td><td className="verified">✓ Matched</td></tr>
                  <tr><td>09:41:28</td><td>RCVD-PRT-8839223</td><td>LED-ACME-77124</td><td>NET-AE10-992323</td><td className="verified">✓ Matched</td></tr>
                  <tr className="bad"><td>09:41:35</td><td>RCVD-PRT-8839224</td><td>LED-ACME-77125</td><td>NET-AE10-992324</td><td>⚠ Mismatch</td></tr>
                </tbody>
              </table>
              </div>
              <div className="lv4-exception" role="note">
                <span className="h">Exception: amount mismatch</span><span className="h">Case ID: EXC-20250515-004135</span>
                <span className="v">Diff: −MYR 128.00 &nbsp;&nbsp; Investigating with partner</span><span className="v">Expected resolution: &lt; 30 min</span>
                <span className="v">Auto resolution: In progress</span><Link href="/login" className="signal">View details →</Link>
              </div>
            </div>
          </div>
        </section>

        {/* Developers */}
        <section id="developers" className="lv4-section" aria-labelledby="developers-title">
          <div className="wrap lv4-dev">
            <div>
              <h2 id="developers-title" className="lv4-h2">Built for developers.</h2>
              <p className="lv4-copy">Clean APIs, verifiable webhooks and idempotent requests. Sandbox available.</p>
              <ul className="lv4-chips">
                <li><i>API</i><div>API v1<span>REST over HTTPS</span></div></li>
                <li><i>SBX</i><div>Sandbox<span>Test with real scenarios</span></div></li>
              </ul>
            </div>
            <div>
              <pre className="lv4-code" tabIndex={0}><span className="k">Request &nbsp;&nbsp; POST &nbsp;/v1/payments</span>{`
{
  "idempotency_key": "9f9bf2fc2-9b7b-4c11-be53-3b6cf81a721",
  "reference": "ACME-INV-77122",
  "origin": { "country": "GB", "currency": "GBP", "amount": "44820.00" },
  "destination": { "country": "MY", "currency": "MYR" },
  "beneficiary": { "name": "Meridian Components", "account": "51234678901" },
  "purpose": "Supplier payment - INV-77122"
}`}</pre>
              <pre className="lv4-code" tabIndex={0}><span className="k">Response &nbsp;&nbsp; 201 Created</span>{`
{
  "payment_id": "SPL-7X0MCC1-0001847",
  "status": "CLEARED",
  "eta": "2025-05-15T08:30:00+00:00",
  "links": { "self": "/v1/payments/SPL-7X0MCC1-0001847" }
}`}</pre>
            </div>
            <div className="lv4-events">
              <div>
                <span className="label">Webhook events</span>
                <ul style={{ marginTop: '0.75rem' }}>
                  <li>payment.cleared</li><li>payment.updated</li><li>payment.settled</li><li>payment.reconciled</li><li>payment.exception</li>
                </ul>
                <p style={{ marginTop: '0.75rem' }}><Link href="/docs">View schema →</Link></p>
              </div>
              <div className="row"><span className="label">Signed requests</span><span>HMAC SHA256</span></div>
              <div className="row" style={{ display: 'grid', gap: '0.25rem' }}><span className="label">Idempotency</span><span style={{ color: 'var(--slate-500)' }}>Safe retries, no duplicates</span></div>
            </div>
          </div>
        </section>

        {/* CTA */}
        <section className="lv4-cta" aria-labelledby="cta-title">
          <div className="wrap">
            <div>
              <h2 id="cta-title">Clear your first corridor.</h2>
              <p>See real routes, real pricing and real evidence in minutes.</p>
            </div>
            <div className="lv4-cta__actions">
              <a href={`mailto:${brand.supportEmail}`} className="btn btn--midnight">Talk to our team <Arrow /></a>
              <Link href="/sandbox" className="btn btn--outline-light">Open sandbox <Arrow /></Link>
              <Plane className="lv4-cta__plane" />
            </div>
          </div>
        </section>
      </main>

      <footer id="company" className="lv4-footer">
        <div className="wrap">
          <div className="lv4-footer__grid">
            <div className="lv4-footer__brand">
              <span className="lv4-wordmark">splash <span className="signal"><Arrow /></span></span>
              <p>Global payment clearance and route intelligence</p>
              <p>{brand.copyright} All rights reserved.</p>
              <p>Jurisdiction notice. Service availability varies by jurisdiction and is subject to local regulations.</p>
            </div>
            {[
              ['Product', [['Platform overview', '#platform'], ['Route intelligence', '#platform'], ['Pricing & FX', '/pricing'], ['Reconciliation', '#security'], ['Evidence & reporting', '/docs']]],
              ['Operate', [['Corridor atlas', '#network'], ['Payout health', '#network'], ['Status', '/metrics'], ['Support', `mailto:${brand.supportEmail}`]]],
              ['Govern', [['Security', '#security'], ['Compliance', '/trust'], ['Data protection', '/trust'], ['Audit & assurance', '/trust']]],
              ['Developers', [['API reference', '/docs'], ['Guides', '/docs'], ['Webhooks', '/docs'], ['Changelog', '/roadmap'], ['Sandbox', '/sandbox']]],
              ['Company', [['About', '/trust'], ['Careers', `mailto:${brand.supportEmail}`], ['News', '/roadmap'], ['Contact', `mailto:${brand.supportEmail}`]]],
              ['Legal', [['Terms of service', '/trust'], ['Privacy policy', '/trust'], ['Cookie policy', '/trust'], ['Jurisdiction info', '/trust']]],
            ].map(([title, links]) => (
              <nav key={String(title)} aria-label={String(title)}>
                <h3>{String(title)}</h3>
                <ul>
                  {(links as [string, string][]).map(([label, href]) => (
                    <li key={label}><Link href={href}>{label}</Link></li>
                  ))}
                </ul>
              </nav>
            ))}
            <div className="lv4-status">
              <span className="label" style={{ color: 'var(--on-dark)' }}>System status</span>
              <div className="row"><span className="lv4-live">All systems operational</span><Link href="/metrics">View status →</Link></div>
              <span className="label" style={{ color: 'var(--on-dark)', marginTop: '0.5rem' }}>Regulated jurisdictions</span>
              <p>{brand.legalEntity} is a technology platform, not a bank. Labuan FSA licensing in process; BNM MSB and BSP planned. Licensed partners are the system of record for regulated activity today.</p>
              <p>Registered in Labuan, Malaysia.</p>
            </div>
          </div>
          <div className="lv4-footer__bottom">15 May 2025 09:41 UTC</div>
        </div>
      </footer>
    </div>
  );
}
