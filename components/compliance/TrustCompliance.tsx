import { FileLock2, Landmark, ShieldCheck, Vault } from 'lucide-react';

/**
 * The "rent, then own" trust argument. Every row states who holds the
 * license or control TODAY; Splash's own licensing is shown as in-process/
 * planned — never implied as held. The mandatory not-yet-licensed line is
 * rendered by this component so no page can crop it away.
 */
const PARTNER_ROWS = [
  {
    partner: 'Coins.ph',
    role: 'Payout partner of record — BSP-licensed local disbursement in the Philippines',
    status: 'Partner rail',
  },
  {
    partner: 'Hata Global',
    role: 'Labuan-regulated liquidity and FX venue for USD legs',
    status: 'Partner rail',
  },
  {
    partner: 'BitGo',
    role: '2-of-3 key governance for operating assets',
    status: 'Custody governance',
  },
  {
    partner: 'CoKeeps / Gambit',
    role: 'Client-asset custody options as corridor volume grows',
    status: 'Custody options',
  },
];

const LICENSE_PATH = [
  { stage: 'In process', body: 'Labuan FSA — money-broking application under preparation with counsel.' },
  { stage: 'Planned', body: 'BNM Money Services Business (Malaysia) and BSP registration (Philippines), sequenced by corridor demand.' },
];

// Folded in from the landing's former "readiness" strip: the controls that
// gate value movement, kept here as a compact security summary.
const CONTROLS = [
  { label: 'Human approval', body: 'Every payment is prepared by 0xWal and released only by a human on the Action Queue — maker-checker, with dual approval above your threshold.' },
  { label: 'Corridor gating', body: 'Corridors arm and pause under explicit controls; settlement halts on a peg deviation or compliance flag before any value moves.' },
  { label: 'Partner custody', body: 'Licensed partners are the system of record for client funds, with 2-of-3 key governance on Splash-side controls.' },
];

export default function TrustCompliance() {
  return (
    <div className="trust-body">
      <div className="trust-mandatory" role="note">
        <ShieldCheck aria-hidden="true" />
        <p>
          <strong>Splash is not yet a licensed money-services business.</strong> Today, licensed
          partners are the system of record for regulated activities; Splash operates the software
          and settlement layer between them.
        </p>
      </div>

      <section className="trust-block">
        <h2><Landmark aria-hidden="true" /> Rent the license, then own it</h2>
        <p>
          The honest sequence for a new corridor: run on partners who already hold the licenses,
          prove volume and controls, then bring the licenses in-house. Who does what today:
        </p>
        <div className="trust-table-wrap">
          <table className="trust-table">
            <thead>
              <tr>
                <th>Partner</th>
                <th>Role of record</th>
                <th>Relationship</th>
              </tr>
            </thead>
            <tbody>
              {PARTNER_ROWS.map((row) => (
                <tr key={row.partner}>
                  <th scope="row">{row.partner}</th>
                  <td>{row.role}</td>
                  <td><span className="trust-chip">{row.status}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="trust-block">
        <h2><Vault aria-hidden="true" /> The licensing path</h2>
        <ul className="trust-path">
          {LICENSE_PATH.map((item) => (
            <li key={item.stage}>
              <span className="trust-chip">{item.stage}</span>
              <p>{item.body}</p>
            </li>
          ))}
        </ul>
      </section>

      <section className="trust-block">
        <h2><FileLock2 aria-hidden="true" /> Audit trail by construction</h2>
        <p>
          Every settlement produces a tamper-proof, Seal-encrypted audit record stored on Walrus and
          anchored on Sui, retained for seven years. Records are private by default; regulators and
          auditors can be granted visibility on authorization — decryption is a permissioned act, not
          a data request. This aligns with Sui&apos;s regulator-visible confidential-transfer
          direction: confidential to the public, verifiable to the people who are supposed to verify.
        </p>
      </section>

      <section className="trust-block">
        <h2><ShieldCheck aria-hidden="true" /> Controls that gate every payment</h2>
        <ul className="trust-controls">
          {CONTROLS.map((control) => (
            <li key={control.label}>
              <span className="trust-chip">{control.label}</span>
              <p>{control.body}</p>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
