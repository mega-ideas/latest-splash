import { FileLock2, Landmark, ShieldCheck, Vault } from 'lucide-react';

/**
 * The "rent, then own" trust argument. Every row states who holds the
 * license or control TODAY; Splash's own licensing is shown as in-process/
 * planned — never implied as held. The mandatory not-yet-licensed line is
 * rendered by this component so no page can crop it away.
 */
const ROLE_ROWS = [
  {
    role: 'Payout of record — Philippines',
    holder: 'A BSP-licensed local disbursement partner',
    status: 'Partner rail',
  },
  {
    role: 'USD collection',
    holder: 'A licensed collection partner holding the client account',
    status: 'Partner rail',
  },
  {
    role: 'Software and settlement layer',
    holder: 'Splash',
    status: 'Not a licence holder',
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
  { label: 'Partner custody', body: 'Licensed partners are the system of record for client funds; Splash never takes custody. Splash-side operator keys are single-signer today — the multisig and KMS split described in the key policy is a mainnet gate, not a control already in force.' },
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
          prove volume and controls, then bring the licenses in-house. Which role holds which
          authority today:
        </p>
        <div className="trust-table-wrap">
          <table className="trust-table">
            <caption className="trust-table-caption">
              Authority by role. A counterparty is named here only once an agreement is
              signed — none is named today.
            </caption>
            <thead>
              <tr>
                <th>Role of record</th>
                <th>Held by</th>
                <th>Relationship</th>
              </tr>
            </thead>
            <tbody>
              {ROLE_ROWS.map((row) => (
                <tr key={row.role}>
                  <th scope="row">{row.role}</th>
                  <td>{row.holder}</td>
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
