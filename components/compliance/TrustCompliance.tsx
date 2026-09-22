import { FileLock2, Landmark, ShieldCheck, Vault } from 'lucide-react';

/**
 * The "rent, then own" trust argument. Every row states who holds the
 * license or control TODAY; Splash's own licensing is shown as in-process/
 * planned — never implied as held. The mandatory not-yet-licensed line is
 * rendered by this component so no page can crop it away.
 */
/**
 * Roles, not names.
 *
 * This table used to name four counterparties — a payout partner, an FX
 * venue, a custody provider and a custody option — as partners with roles
 * of record. None of them is signed.
 * unsigned counterparty on a public compliance page is the claim, whatever
 * the "Relationship" column says beside it: a reader takes the row as
 * evidence the arrangement exists, and the named firm finds a statement
 * made on its behalf without its agreement.
 *
 * The argument this section makes — rent the licence, prove the corridor,
 * then bring it in-house — does not need the names. It needs the shape of
 * the arrangement, which is what these rows state. Each name goes into the
 * row it belongs to on the day its agreement is signed, and not before.
 */
const ROLE_ROWS = [
  {
    role: "Payout of record",
    body: "A local disbursement partner of record holds the licence and the client relationship in the destination market. Splash instructs; the partner pays out.",
    status: "Not yet signed",
  },
  {
    role: "Collection of record",
    body: "A provider of record holds incoming USD. This is the one role with a named provider anywhere on this page, because it is the one that is live.",
    status: "Airwallex · live on the testnet corridor",
  },
  {
    role: "FX and liquidity",
    body: "A regulated venue prices and fills the USD leg, sourced per corridor as volume justifies a dedicated agreement.",
    status: "Not yet signed",
  },
  {
    role: "Client-asset custody",
    body: "Client funds sit with a custodian of record, never with Splash. splash_core structurally cannot hold a value-bearing field, and CI enforces that on every push.",
    status: "Not yet signed",
  },
];

const LICENSE_PATH = [
  { stage: 'In preparation', body: 'Labuan FSA — money-broking application under preparation with counsel.' },
  { stage: 'Planned', body: 'Further licences are sequenced by corridor demand, and none is named until an application is filed.' },
];

// Folded in from the landing's former "readiness" strip: the controls that
// gate value movement, kept here as a compact security summary.
const CONTROLS = [
  { label: 'Human approval', body: 'Every payment is prepared by 0xWal and released only by a human on the Action Queue — maker-checker, with dual approval above your threshold.' },
  { label: 'Corridor gating', body: 'Corridors arm and pause under explicit controls; settlement halts on a peg deviation or compliance flag before any value moves.' },
  { label: "Partner custody", body: "Partners of record hold client funds. Splash-side control is maker-checker — 0xWal prepares, a named human releases — and splash_core holds no client value, which is a property CI enforces rather than a key policy asserted in prose." },
];

export default function TrustCompliance() {
  return (
    <div className="trust-body">
      <div className="trust-mandatory" role="note">
        <ShieldCheck aria-hidden="true" />
        <p>
          <strong>Splash is not yet a licensed money-services business.</strong> Today, partners of record
          carry out the regulated activities; Splash operates the software
          and settlement layer between them.
        </p>
      </div>

      <section className="trust-block">
        <h2><Landmark aria-hidden="true" /> Rent the license, then own it</h2>
        <p>
          The honest sequence for a new corridor: run on partners who already hold the licenses,
          prove volume and controls, then bring the licenses in-house. The roles that needs, and
          where each stands today. A counterparty is named once its agreement is signed:
        </p>
        <div className="trust-table-wrap">
          <table className="trust-table">
            <thead>
              <tr>
                <th>Role</th>
                <th>What it means</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {ROLE_ROWS.map((row) => (
                <tr key={row.role}>
                  <th scope="row">{row.role}</th>
                  <td>{row.body}</td>
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
          Every settlement produces a tamper-proof, encrypted audit record stored permanently and
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
