'use client';

import { Download, Upload } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';

import ExplorerLinks from '@/components/dashboard/ExplorerLinks';
import { EmptyState as IsoEmptyState, SuiSettlementStack } from '@/components/illustrations/iso';
import { Badge, Button, Card, Chip, EmptyState, ProofRow, Stat, StepStrip, Table } from '@/components/system';
import type { BadgeTone } from '@/components/system';
import { CSV_HEADER, SAMPLE_ROWS, SUPPORTED_COUNTRIES, buildSampleCsv, rescreen, screenRows, type BatchRow, type BatchRowStatus } from '@/lib/batch/screen';
import { parseBatchFile, takeBatchDraft } from '@/lib/batch-parse';
import { getCorridorFeeBps } from '@/lib/fx/corridors';
import { getNetworkProfile } from '@/lib/network';
import { MAX_BATCH_ROWS } from '@/lib/policy/batch-limits';
import { checkMinimumSettlement, formatUsd, minSettlementUsd } from '@/lib/policy/limits';
import { cn } from '@/lib/utils';

type Phase = 'upload' | 'validate' | 'review' | 'settle' | 'receipt';
type BatchStatus = { id: string; state: string; rowCount: number; acceptedRows: number; totalAmount: string; digest: string | null; demo?: boolean };

const STEPS = [{ label: 'Upload' }, { label: 'Validate' }, { label: 'Review' }, { label: 'Settle' }, { label: 'Receipt' }];
const PHASES: Phase[] = ['upload', 'validate', 'review', 'settle', 'receipt'];

const usd = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function rowTone(status: BatchRowStatus): BadgeTone {
  if (status === 'ready' || status === 'settled') return 'green';
  if (status === 'queued') return 'teal';
  if (status === 'review') return 'amber';
  return 'red';
}

const ROW_LABEL: Record<BatchRowStatus, string> = { ready: 'Cleared', review: 'Needs review', blocked: 'Blocked', queued: 'Queued', settled: 'Settled', failed: 'Failed' };

const fieldClass = 'h-10 w-full rounded-[8px] border border-[var(--line)] bg-[var(--surface)] px-2 text-[14px] text-[var(--text)] outline-none focus:border-[var(--teal-600)]';

/**
 * Batch payout: upload → validate (row chips, inline fixes) → review
 * (corridor split, chunk preview) → settle (one authorisation, one digest
 * per chunk) → receipt with per-row states. Screening here is a preview;
 * the server re-runs every check before anything moves.
 */
export default function BatchPage() {
  const [phase, setPhase] = useState<Phase>('upload');
  const [rows, setRows] = useState<BatchRow[]>([]);
  const [fileName, setFileName] = useState<string | null>(null);
  const [totp, setTotp] = useState('');
  const [busy, setBusy] = useState(false);
  const [batchId, setBatchId] = useState<string | null>(null);
  const [status, setStatus] = useState<BatchStatus | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const corridors = getNetworkProfile().corridors;

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('draft') === '1') {
      const draft = takeBatchDraft();
      if (draft && draft.rows.length > 0) {
        const timer = window.setTimeout(() => {
          setRows(screenRows(draft.rows));
          setFileName(draft.fileName);
          setPhase('validate');
          toast.success(`Prepared ${draft.rows.length} rows from ${draft.fileName}`);
        }, 0);
        return () => window.clearTimeout(timer);
      }
    }
  }, []);

  const pollBatch = useCallback(async (id: string) => {
    try {
      const response = await fetch(`/api/batches/${id}`, { cache: 'no-store' });
      if (!response.ok) return null;
      const data = (await response.json()) as BatchStatus;
      setStatus(data);
      return data.state;
    } catch {
      return null;
    }
  }, []);

  useEffect(() => {
    if (!batchId) return;
    const first = window.setTimeout(() => void pollBatch(batchId), 0);
    const interval = window.setInterval(async () => {
      const state = await pollBatch(batchId);
      if (state === 'SETTLED' || state === 'FAILED' || state === 'REFUNDED') {
        window.clearInterval(interval);
        setRows((current) => current.map((row) => (row.status === 'queued' ? { ...row, status: state === 'SETTLED' ? 'settled' : 'failed' } : row)));
        setPhase('receipt');
      }
    }, 2000);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(interval);
    };
  }, [batchId, pollBatch]);

  const accepted = useMemo(() => rows.filter((row) => row.status === 'ready' || row.status === 'queued' || row.status === 'settled'), [rows]);
  const review = useMemo(() => rows.filter((row) => row.status === 'review'), [rows]);
  const blocked = useMemo(() => rows.filter((row) => row.status === 'blocked' || row.status === 'failed'), [rows]);
  const acceptedTotal = useMemo(() => accepted.reduce((sum, row) => sum + (Number.parseFloat(row.amount) || 0), 0), [accepted]);
  const corridorSplit = useMemo(() => {
    const map = new Map<string, { count: number; total: number }>();
    for (const row of accepted) {
      const entry = map.get(row.country) ?? { count: 0, total: 0 };
      entry.count += 1;
      entry.total += Number.parseFloat(row.amount) || 0;
      map.set(row.country, entry);
    }
    return [...map.entries()].sort((a, b) => b[1].total - a[1].total);
  }, [accepted]);
  const chunkCount = Math.max(1, Math.ceil(accepted.length / MAX_BATCH_ROWS));
  const estimatedFee = accepted.reduce((sum, row) => sum + ((Number.parseFloat(row.amount) || 0) * getCorridorFeeBps(row.country === 'PH' ? 'PHP' : row.country === 'ID' ? 'IDR' : 'PHP')) / 10_000, 0);
  const minimum = checkMinimumSettlement(acceptedTotal, 'batch');

  async function onFile(file: File) {
    try {
      const parsed = await parseBatchFile(file);
      if (parsed.rows.length === 0) throw new Error('No payable rows found in that file');
      setRows(screenRows(parsed.rows));
      setFileName(parsed.fileName);
      setBatchId(null);
      setStatus(null);
      setPhase('validate');
      toast.success(`${parsed.rows.length} rows screened`);
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : 'Could not read that file');
    }
  }

  function loadSample() {
    setRows(screenRows(SAMPLE_ROWS));
    setFileName('splash-batch-sample.csv');
    setPhase('validate');
  }

  function downloadSample() {
    const blob = new Blob([buildSampleCsv()], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'splash-batch-sample.csv';
    anchor.click();
    URL.revokeObjectURL(url);
  }

  function editRow(id: string, patch: Partial<Pick<BatchRow, 'purpose' | 'country' | 'amount'>>) {
    setRows((current) => rescreen(current.map((row) => (row.id === id ? { ...row, ...patch } : row))));
  }

  async function authorize() {
    if (!/^\d{6}$/.test(totp)) {
      toast.error('Enter your 6-digit authorisation code');
      return;
    }
    if (accepted.length === 0) {
      toast.error('No rows are cleared for authorisation');
      return;
    }
    if (!minimum.ok) {
      toast.error(minimum.message);
      return;
    }
    if (accepted.length > MAX_BATCH_ROWS) {
      toast.error(`A single settlement carries at most ${MAX_BATCH_ROWS} rows. Split the file and authorise each chunk.`);
      return;
    }
    setBusy(true);
    try {
      const response = await fetch('/api/batches/authorize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rows: accepted.map(({ name, address, country, purpose, amount }) => ({ name, address, country, purpose, amount })), totp }),
      });
      if (!response.ok) {
        const body = (await response.json()) as { error?: string };
        throw new Error(body.error ?? 'Batch authorisation failed');
      }
      const body = (await response.json()) as { id: string; blockedRows: number };
      setBatchId(body.id);
      setRows((current) => current.map((row) => (row.status === 'ready' ? { ...row, status: 'queued' } : row)));
      setPhase('settle');
      toast.success(body.blockedRows > 0 ? 'Cleared rows queued with exceptions' : 'Batch queued for settlement');
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : 'Batch authorisation failed');
      setRows((current) => current.map((row) => (row.status === 'ready' ? { ...row, status: 'failed' } : row)));
    } finally {
      setBusy(false);
      setTotp('');
    }
  }

  const settled = status?.state === 'SETTLED';
  const failed = status?.state === 'FAILED' || status?.state === 'REFUNDED';
  const simulated = Boolean(status?.demo) || Boolean(status?.digest?.startsWith('SIM_'));

  return (
    <div className="mx-auto grid w-full max-w-[1040px] gap-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[var(--text-h1)] font-semibold leading-[1.1] tracking-[-0.02em]">Batch payout</h1>
          <p className="mt-1 text-[14px] text-[var(--text-2)]">Fifty suppliers, two countries, one file. Every row is screened before one authorisation settles the chunk.</p>
        </div>
        {fileName ? <Chip>{fileName}</Chip> : null}
      </header>

      <StepStrip steps={STEPS} current={PHASES.indexOf(phase)} />

      {phase === 'upload' ? (
        <Card padding="lg" className="grid gap-5">
          <input ref={fileInput} type="file" accept=".csv,.xlsx,.xls,text/csv" className="sr-only" onChange={(event) => event.target.files?.[0] && void onFile(event.target.files[0])} />
          <button
            type="button"
            onClick={() => fileInput.current?.click()}
            className="grid min-h-[200px] place-items-center gap-3 rounded-[var(--r-md)] border-2 border-dashed border-[var(--line)] bg-[var(--surface-2)] p-8 text-center outline-none transition-colors hover:border-[var(--teal-600)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--teal-500)]"
          >
            <span className="w-full max-w-[200px]">
              <IsoEmptyState kind="invoices" decorative />
            </span>
            <span className="text-[15px] font-semibold text-[var(--text)]">
              <Upload className="mr-2 inline size-4" aria-hidden="true" /> Choose a CSV or spreadsheet
            </span>
            <span className="text-[13px] text-[var(--text-2)]">
              Columns <code className="font-mono">{CSV_HEADER}</code> · amounts in USD · country as ISO-2. On a phone, share the file to Splash or pick it from Files.
            </span>
          </button>
          <div className="flex flex-wrap gap-2">
            <Button variant="ghost" onClick={downloadSample}>
              <Download aria-hidden="true" /> Download sample
            </Button>
            <Button variant="ghost" onClick={loadSample}>
              Try the sample file
            </Button>
          </div>
          <p className="text-[12px] text-[var(--text-muted)]">
            Supported corridors now: {corridors.map((corridor) => `${corridor.country} (${corridor.currency})`).join(', ')} · staggered launch. Other ISO-2 countries stay modeled and are blocked in preflight.
          </p>
        </Card>
      ) : null}

      {phase === 'validate' ? (
        <div className="grid gap-4">
          <section className="grid gap-3 sm:grid-cols-3" aria-label="Screening summary">
            <Card padding="sm">
              <Stat label="Cleared" value={String(accepted.length)} tone="positive" sub={`${usd.format(acceptedTotal)} USD`} />
            </Card>
            <Card padding="sm">
              <Stat label="Needs review" value={String(review.length)} tone={review.length ? 'pending' : 'default'} sub="Fix inline to clear" />
            </Card>
            <Card padding="sm">
              <Stat label="Blocked" value={String(blocked.length)} tone={blocked.length ? 'negative' : 'default'} sub="Excluded from this run" />
            </Card>
          </section>

          <Table
            caption="Rows"
            exportName="batch-preflight"
            rows={rows}
            emptyState={<EmptyState title="No rows" body="Upload a file to screen it." />}
            columns={[
              { key: 'name', header: 'Beneficiary', value: (row) => row.name, render: (row) => (
                <span className="grid">
                  <span className="font-medium">{row.name || 'Unnamed beneficiary'}</span>
                  <span className="font-mono text-[12px] text-[var(--text-muted)]">{row.address || 'Missing reference'}</span>
                </span>
              ) },
              { key: 'country', header: 'Country', value: (row) => row.country, render: (row) => (
                row.status === 'blocked' || row.status === 'review' ? (
                  <select aria-label={`Country for ${row.name}`} value={row.country} onChange={(event) => editRow(row.id, { country: event.target.value })} className={fieldClass}>
                    {[...SUPPORTED_COUNTRIES].map((code) => <option key={code} value={code}>{code}</option>)}
                    {!SUPPORTED_COUNTRIES.has(row.country) ? <option value={row.country}>{row.country || '—'}</option> : null}
                  </select>
                ) : row.country
              ) },
              { key: 'purpose', header: 'Purpose', value: (row) => row.purpose, render: (row) => (
                row.status === 'review' || row.status === 'blocked' ? (
                  <input aria-label={`Purpose code for ${row.name}`} value={row.purpose} placeholder="Purpose code" onChange={(event) => editRow(row.id, { purpose: event.target.value })} className={fieldClass} />
                ) : row.purpose
              ) },
              { key: 'amount', header: 'Amount (USD)', align: 'right', mono: true, value: (row) => row.amount, render: (row) => (
                row.status === 'blocked' || row.status === 'review' ? (
                  <input aria-label={`Amount for ${row.name}`} inputMode="decimal" value={row.amount} onChange={(event) => editRow(row.id, { amount: event.target.value.replace(/[^0-9.]/g, '') })} className={cn(fieldClass, 'text-right font-mono')} />
                ) : usd.format(Number.parseFloat(row.amount) || 0)
              ) },
              { key: 'status', header: 'Screening', value: (row) => ROW_LABEL[row.status], render: (row) => (
                <span className="grid gap-1">
                  <Badge tone={rowTone(row.status)}>{ROW_LABEL[row.status]}</Badge>
                  {row.status !== 'ready' ? <span className="text-[12px] text-[var(--text-muted)]">{row.checks.filter((check) => check.result !== 'PASS').map((check) => check.detail).join(' · ')}</span> : null}
                </span>
              ) },
            ]}
          />

          <div className="flex flex-wrap justify-between gap-2">
            <Button variant="ghost" onClick={() => setPhase('upload')}>
              Upload a different file
            </Button>
            <Button size="lg" onClick={() => setPhase('review')} disabled={accepted.length === 0}>
              Review {accepted.length} cleared rows
            </Button>
          </div>
        </div>
      ) : null}

      {phase === 'review' ? (
        <div className="grid gap-4 lg:grid-cols-[1.2fr_0.8fr]">
          <div className="grid gap-4">
            <Card className="grid gap-3">
              <h2 className="text-[15px] font-semibold">Corridor split</h2>
              <ul className="grid gap-2">
                {corridorSplit.map(([country, entry]) => {
                  const corridor = corridors.find((item) => item.code === country);
                  return (
                    <li key={country} className="flex flex-wrap items-center justify-between gap-2 rounded-[var(--r-sm)] bg-[var(--surface-2)] px-3 py-2">
                      <span className="flex items-center gap-2 text-[14px] font-medium">
                        USD → {corridor?.currency ?? country}
                        <Chip tone="teal">{corridor?.partnerLabel ?? `Corridor ${country}`}</Chip>
                      </span>
                      <span className="font-mono text-[13px] tabular-nums">
                        {entry.count} rows · {usd.format(entry.total)} USD
                      </span>
                    </li>
                  );
                })}
              </ul>
            </Card>
            <Card className="grid gap-3">
              <h2 className="text-[15px] font-semibold">Chunk preview</h2>
              <p className="text-[13px] text-[var(--text-2)]">
                A single settlement carries at most {MAX_BATCH_ROWS} rows; everyone in a chunk gets paid, or nobody does. This run is {chunkCount === 1 ? 'one chunk' : `${chunkCount} chunks`} of {accepted.length} rows.
              </p>
              <div className="flex flex-wrap gap-2">
                {Array.from({ length: chunkCount }).map((_, index) => (
                  <Chip key={index} tone={index === 0 ? 'green' : 'default'} ghost={index > 0}>
                    chunk {index + 1} · {Math.min(MAX_BATCH_ROWS, accepted.length - index * MAX_BATCH_ROWS)} rows
                  </Chip>
                ))}
              </div>
              {chunkCount > 1 ? <p className="text-[13px] text-[var(--warn)]">Only the first chunk can be authorised in this run. Split the file and authorise each chunk separately.</p> : null}
            </Card>
          </div>
          <div className="grid gap-4">
            <Card className="grid gap-3">
              <h2 className="text-[15px] font-semibold">Authorisation</h2>
              <dl>
                <ProofRow label="Cleared total" value={<span className="font-mono tabular-nums">{usd.format(acceptedTotal)} USD</span>} />
                <ProofRow label="Fee (illustrative)" value={<span className="font-mono tabular-nums">{usd.format(estimatedFee)} USD</span>} />
                <ProofRow label="Excluded" value={`${review.length + blocked.length} rows`} />
                <ProofRow label="Minimum" value={formatUsd(minSettlementUsd())} />
              </dl>
              {!minimum.ok && acceptedTotal > 0 ? <p className="text-[13px] text-[var(--warn)]">{minimum.message}</p> : null}
              <form
                className="grid gap-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  void authorize();
                }}
              >
                <label htmlFor="batch-totp" className="text-[14px] font-semibold">
                  6-digit authorisation code
                </label>
                <input
                  id="batch-totp"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  value={totp}
                  onChange={(event) => setTotp(event.target.value.replace(/\D/g, '').slice(0, 6))}
                  placeholder="000000"
                  className="h-12 rounded-[var(--r-sm)] border border-[var(--line)] bg-[var(--surface)] px-4 text-center font-mono text-[18px] tracking-[0.3em] text-[var(--text)] outline-none focus:border-[var(--teal-600)]"
                />
                <Button type="submit" size="lg" fullWidth disabled={busy || accepted.length === 0 || totp.length !== 6 || !minimum.ok}>
                  {busy ? 'Queueing…' : `Authorise ${Math.min(accepted.length, MAX_BATCH_ROWS)} rows`}
                </Button>
                <p className="text-[12px] text-[var(--text-muted)]">One signed authorisation. The server re-screens every row, then one atomic transaction per chunk settles on Sui.</p>
              </form>
              <Button variant="ghost" onClick={() => setPhase('validate')}>
                Back to rows
              </Button>
            </Card>
          </div>
        </div>
      ) : null}

      {phase === 'settle' ? (
        <Card tone={settled ? 'dark' : 'default'} className="grid gap-4 md:grid-cols-[220px_1fr] md:items-center" aria-live="polite">
          <div className="mx-auto w-full max-w-[220px]">
            <SuiSettlementStack settled={settled} assembling={!settled && !failed} decorative />
          </div>
          <div className={cn('grid gap-2', settled && 'text-white')}>
            <h2 className="text-[var(--text-h3)] font-semibold">{settled ? 'Chunk settled on Sui' : failed ? 'Chunk did not settle' : 'Settling chunk 1'}</h2>
            <p className={cn('text-[14px]', settled ? 'text-white/70' : 'text-[var(--text-2)]')}>
              {status ? `${status.acceptedRows} rows · ${status.totalAmount} USD · ${status.state}` : 'Queued. This screen updates on its own.'}
            </p>
            {status?.digest ? (
              simulated ? (
                <Badge tone="amber">Simulated batch · no on-chain transaction</Badge>
              ) : (
                <ExplorerLinks digest={status.digest} />
              )
            ) : null}
            {status ? <p className={cn('font-mono text-[12px]', settled ? 'text-white/60' : 'text-[var(--text-muted)]')}>Batch {status.id}</p> : null}
          </div>
        </Card>
      ) : null}

      {phase === 'receipt' ? (
        <div className="grid gap-4">
          <Card tone={settled ? 'dark' : 'tint'} className={cn('grid gap-2', settled && 'text-white')}>
            <h2 className="text-[var(--text-h3)] font-semibold">{settled ? 'Batch receipt' : 'Batch returned'}</h2>
            <p className={cn('text-[14px]', settled ? 'text-white/70' : 'text-[var(--text-2)]')}>
              {status?.acceptedRows ?? accepted.length} rows · {status?.totalAmount ?? usd.format(acceptedTotal)} USD · {status?.state ?? '—'}
            </p>
            {status?.digest ? (simulated ? <Badge tone="amber">Simulated · no on-chain transaction</Badge> : <ExplorerLinks digest={status.digest} />) : null}
          </Card>
          <Table
            caption="Rows in this run"
            exportName="batch-receipt"
            rows={rows}
            columns={[
              { key: 'name', header: 'Beneficiary', value: (row) => row.name },
              { key: 'country', header: 'Corridor', value: (row) => `USD → ${row.country}`, render: (row) => `USD → ${row.country}` },
              { key: 'amount', header: 'Amount (USD)', align: 'right', mono: true, value: (row) => row.amount, render: (row) => usd.format(Number.parseFloat(row.amount) || 0) },
              { key: 'status', header: 'State', value: (row) => ROW_LABEL[row.status], render: (row) => <Badge tone={rowTone(row.status)}>{ROW_LABEL[row.status]}</Badge> },
              { key: 'digest', header: 'Digest', mono: true, secondary: true, value: () => status?.digest ?? '', render: (row) => (row.status === 'settled' && status?.digest && !simulated ? `${status.digest.slice(0, 10)}…` : '—') },
            ]}
          />
          <div className="flex flex-wrap gap-2">
            <Button href="/dashboard/receipts">Open receipts</Button>
            <Button
              variant="ghost"
              onClick={() => {
                setRows([]);
                setFileName(null);
                setBatchId(null);
                setStatus(null);
                setPhase('upload');
              }}
            >
              New batch
            </Button>
          </div>
        </div>
      ) : null}

      {phase !== 'upload' && review.length + blocked.length > 0 && phase !== 'receipt' ? (
        <p className="text-[13px] text-[var(--text-2)]">
          {review.length} row{review.length === 1 ? '' : 's'} need a fix and {blocked.length} {blocked.length === 1 ? 'is' : 'are'} blocked. Cleared rows still ship; the rest stay on this screen until you resolve them.
        </p>
      ) : null}
      <p className="text-[12px] text-[var(--text-muted)]">Screening here is a preflight preview; the server is the gate and re-runs every check before value moves.</p>
    </div>
  );
}
