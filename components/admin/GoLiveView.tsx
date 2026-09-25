import { CircleCheck, CircleDashed, CircleX } from 'lucide-react';

import type { Check, HealthReport } from '@/lib/server/health-checks';

/**
 * The Go-live page's body: a health report, rendered. Pure (no data
 * fetching), so the page supplies a live report and a render check can supply
 * a fixed one. app/admin/(console)/go-live/page.tsx runs the checks.
 */

type Key = keyof HealthReport['checks'];
type Row = { key: Key; name: string; role: string };

// In the order docs/STABLECOIN-LANE.md and the setup guide walk them.
const MONEY: Row[] = [
  { key: 'laneNode', name: 'Sui mainnet node', role: 'Builds, dry-runs and sends USDC transfers' },
  { key: 'peg', name: 'Stablecoin peg (DeepBook)', role: 'Gates every payout' },
  { key: 'usdyPrice', name: 'USDY price (Ondo)', role: 'Values the treasury preview' },
  { key: 'feeAddress', name: 'Fee wallet', role: 'Receives the 0.80% on USDC wallet transfers' },
  { key: 'twilio', name: 'WhatsApp codes (Twilio)', role: 'Delivers approval codes to the main admin' },
  { key: 'passkeyDomain', name: 'Passkey domain', role: "Ties each admin's Splash wallet to this site" },
  { key: 'screening', name: 'Wallet screening (Chainalysis)', role: 'Checks new wallet recipients against sanctions lists' },
];

const INFRASTRUCTURE: Row[] = [
  { key: 'rpc', name: 'Sui RPC', role: 'The app network the contracts live on' },
  { key: 'package', name: 'Splash package', role: 'The published Move package' },
  { key: 'db', name: 'Postgres', role: 'Ledger, approvals and the 30-day allowance' },
  { key: 'seal', name: 'Seal', role: 'Encrypted records' },
  { key: 'enoki', name: 'Enoki', role: 'Gas sponsorship' },
];

const STATUS = {
  ok: { word: 'Working', Icon: CircleCheck, icon: 'text-[var(--ok)]', chip: 'bg-[var(--ok-bg)]' },
  skipped: { word: 'Not set up', Icon: CircleDashed, icon: 'text-[var(--pending)]', chip: 'bg-[var(--pending-bg)]' },
  fail: { word: 'Failing', Icon: CircleX, icon: 'text-[var(--error)]', chip: 'bg-[var(--error-bg)]' },
} as const;

function StatusChip({ status }: { status: Check['status'] }) {
  const { word, Icon, icon, chip } = STATUS[status];
  return (
    <span className={`inline-flex w-fit items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-bold text-[var(--ink)] ${chip}`}>
      <Icon className={`h-4 w-4 ${icon}`} aria-hidden="true" />
      {word}
    </span>
  );
}

function CheckList({ id, title, lead, rows, report }: { id: string; title: string; lead: string; rows: Row[]; report: HealthReport }) {
  return (
    <section aria-labelledby={id} className="dash-surface p-5 md:p-6">
      <h2 id={id} className="text-lg font-black text-[#1f4350]">{title}</h2>
      <p className="mt-1 max-w-3xl text-sm leading-6 text-[#326273]/90">{lead}</p>
      <ul className="mt-4 divide-y divide-[#326273]/10">
        {rows.map(({ key, name, role }) => {
          const check = report.checks[key];
          return (
            <li key={key} className="grid gap-2 py-4 md:grid-cols-[8.5rem_minmax(12rem,16rem)_1fr_auto] md:items-baseline md:gap-4">
              <StatusChip status={check.status} />
              <div>
                <div className="font-bold text-[#1f4350]">{name}</div>
                <div className="text-xs leading-5 text-[#326273]/90">{role}</div>
              </div>
              <p className="text-sm leading-6 text-[#326273] [overflow-wrap:anywhere]">{check.detail}</p>
              <span className="text-xs tabular-nums text-[#326273]/90 md:text-right">
                {check.latencyMs === undefined ? '' : `${check.latencyMs} ms`}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export default function GoLiveView({ report, rerunHref }: { report: HealthReport; rerunHref: string }) {
  const all = Object.values(report.checks);
  const count = (status: Check['status']) => all.filter((check) => check.status === status).length;
  const failing = count('fail');
  const notSetUp = count('skipped');

  return (
    <div className="mx-auto max-w-7xl space-y-6">
      <header className="dash-surface p-6 md:p-8">
        <span className="dash-kicker">Go-live</span>
        <h1 className="dash-title mt-2 text-4xl">Is this server ready to move real money?</h1>
        <p className="mt-3 max-w-3xl text-sm leading-6 text-[#326273]/90">
          The checks <code className="font-mono text-[13px]">npm run doctor</code> prints, run now on this server.
          &ldquo;Not set up&rdquo; means a step nobody has done yet, and says what stays closed until it is.
          &ldquo;Failing&rdquo; means something is set but wrong, or a source did not answer, and says what to fix.
          Nothing here sends a message or moves money.
        </p>
        <p className="mt-4 text-sm font-semibold text-[#1f4350]" role="status">
          {failing === 0 ? 'Nothing is failing.' : `${failing} failing.`}
          {notSetUp > 0 ? ` ${notSetUp} not set up yet.` : ''}
          <span className="font-normal text-[#326273]/90"> Checked {report.checkedAt.slice(11, 19)} UTC · </span>
          <a href={rerunHref} className="font-semibold text-[var(--info)] underline-offset-4 hover:underline focus-visible:underline">
            Run the checks again
          </a>
        </p>
      </header>

      <CheckList
        id="go-live-money"
        title="Moving real money"
        lead="The setup a person does by hand: the price sources payouts and the treasury preview read, the fee wallet, WhatsApp delivery, the passkey domain and wallet screening."
        rows={MONEY}
        report={report}
      />
      <CheckList
        id="go-live-infrastructure"
        title="Infrastructure"
        lead="What the app needs to run at all."
        rows={INFRASTRUCTURE}
        report={report}
      />
    </div>
  );
}
