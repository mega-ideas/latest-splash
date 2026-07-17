"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, Clock, Download, FileWarning, Layers, Loader2, PercentCircle, ShieldCheck, Upload, Wallet, XCircle, type LucideIcon } from "lucide-react";
import Papa from "papaparse";
import { toast } from "sonner";

import HoverPopup from "@/components/HoverPopup";
import StatusBadge from "@/components/StatusBadge";
import DashPageHeader from "@/components/dashboard/DashPageHeader";
import DashStat from "@/components/dashboard/DashStat";
import ExplorerLinks from "@/components/dashboard/ExplorerLinks";
import SettlementEngineFlow from "@/components/dashboard/SettlementEngineFlow";
import { takeBatchDraft } from "@/lib/batch-parse";

type ComplianceResult = "PASS" | "REVIEW" | "BLOCK";

type ComplianceCheck = {
  label: string;
  result: ComplianceResult;
  detail: string;
};

type BatchRow = {
  name: string;
  address: string;
  country: string;
  purpose: string;
  amount: string;
  status: "ready" | "review" | "blocked" | "queued" | "failed";
  checks: ComplianceCheck[];
};

type BatchStatus = {
  id: string;
  state: string;
  rowCount: number;
  acceptedRows: number;
  totalAmount: string;
  digest: string | null;
  explorer: { suiVisionTxUrl: string | null; suiScanTxUrl: string | null };
  demo?: boolean;
};

type CsvRow = {
  name?: string;
  address?: string;
  country?: string;
  purpose?: string;
  amount?: string | number;
};

const supportedCountries = new Set(["MY", "PH", "ID", "SG", "VN", "TH", "EU", "GB"]);
const sentinelNames = ["sanction", "blocked", "pep hit", "watchlist"];

const sampleCsvRows: Array<{ name: string; address: string; country: string; purpose: string; amount: string }> = [
  { name: "Acme Philippines Corp", address: "PH1234567890", country: "PH", purpose: "Vendor invoice", amount: "12000.00" },
  { name: "Jakarta Supplies PT", address: "ID9988776655", country: "ID", purpose: "Vendor invoice", amount: "8500.00" },
  { name: "Global IT Solutions Pte", address: "SG5544332211", country: "SG", purpose: "Service fee", amount: "3200.00" },
  { name: "Manila BPO Services", address: "PH4567891234", country: "PH", purpose: "Payroll", amount: "15000.00" },
];

const csvHeader = "name,address,country,purpose,amount";

function buildSampleCsv() {
  const rows = sampleCsvRows.map((row) => [row.name, row.address, row.country, row.purpose, row.amount].join(","));
  return [csvHeader, ...rows].join("\n");
}

const batchBenefits = [
  {
    icon: PercentCircle,
    title: "15–30 bps cheaper FX",
    body: "Batched rows are netted against treasury inventory, so we quote one tighter rate instead of paying spread on every transfer.",
  },
  {
    icon: ShieldCheck,
    title: "One signed authorization",
    body: "Approve the whole payroll with a single TOTP. No re-keying per beneficiary, and an immutable approver trail on Sui.",
  },
  {
    icon: CheckCircle2,
    title: "Atomic compliance",
    body: "AML, KYT, structuring and corridor checks run before any value moves. Bad rows are isolated; cleared rows still ship.",
  },
  {
    icon: Wallet,
    title: "One reconciliation entry",
    body: "Operating account sees a single debit and a merkle-rooted receipt — your accountants stop reconciling 50 line items.",
  },
  {
    icon: Layers,
    title: "Off-peak window pricing",
    body: "Batches can target the next settlement window where corridor fees drop further, saving on cross-border partner costs.",
  },
];

function strongestResult(checks: ComplianceCheck[]): ComplianceResult {
  if (checks.some((check) => check.result === "BLOCK")) return "BLOCK";
  if (checks.some((check) => check.result === "REVIEW")) return "REVIEW";
  return "PASS";
}

function badgeClass(result: ComplianceResult) {
  if (result === "PASS") return "border-[#5C9EAD]/30 bg-[#5C9EAD]/10 text-[#5C9EAD]";
  if (result === "REVIEW") return "border-[#E39774]/30 bg-[#E39774]/10 text-[#E39774]";
  return "border-red-500/30 bg-red-500/10 text-red-600";
}

function rowStatus(result: ComplianceResult): BatchRow["status"] {
  if (result === "PASS") return "ready";
  if (result === "REVIEW") return "review";
  return "blocked";
}

function evaluateRow(row: Omit<BatchRow, "status" | "checks">, duplicateCount: number): ComplianceCheck[] {
  const amount = Number.parseFloat(row.amount || "0");
  const lowerName = String(row.name ?? '').toLowerCase();
  const checks: ComplianceCheck[] = [
    {
      label: "AML sanctions / PEP",
      result: sentinelNames.some((term) => lowerName.includes(term)) ? "BLOCK" : "PASS",
      detail: sentinelNames.some((term) => lowerName.includes(term)) ? "Potential sanctions or PEP hit" : "No list match in dev screen",
    },
    {
      label: "KYT amount rule",
      result: amount > 5000 ? "REVIEW" : amount > 0 ? "PASS" : "BLOCK",
      detail: amount > 5000 ? "Above Tier 1 single-transfer review threshold" : amount > 0 ? "Within Tier 1 single-transfer threshold" : "Amount must be greater than zero",
    },
    {
      label: "KYT structuring",
      result: duplicateCount >= 4 ? "REVIEW" : "PASS",
      detail: duplicateCount >= 4 ? "Repeated beneficiary appears multiple times in this batch" : "No structuring pattern detected",
    },
    {
      label: "Corridor allowlist",
      result: supportedCountries.has(row.country) ? "PASS" : "BLOCK",
      detail: supportedCountries.has(row.country) ? `${row.country} corridor is enabled` : `${row.country || "Unknown"} corridor is not enabled`,
    },
    {
      label: "Purpose code",
      result: row.purpose ? "PASS" : "REVIEW",
      detail: row.purpose ? row.purpose : "Purpose code required before release",
    },
  ];

  return checks;
}

function screenRows(rows: Array<Omit<BatchRow, "status" | "checks">>): BatchRow[] {
  const duplicateCounts = rows.reduce<Record<string, number>>((counts, row) => {
    const key = row.address || row.name;
    counts[key] = (counts[key] ?? 0) + 1;
    return counts;
  }, {});

  return rows.map((row) => {
    const checks = evaluateRow(row, duplicateCounts[row.address || row.name] ?? 1);
    return { ...row, checks, status: rowStatus(strongestResult(checks)) };
  });
}

export default function BatchPage() {
  const [rows, setRows] = useState<BatchRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [totp, setTotp] = useState("");
  const [batchId, setBatchId] = useState<string | null>(null);
  const [batchStatus, setBatchStatus] = useState<BatchStatus | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);

    // Draft handed over from the 0xWal composer's file upload (prepared, not
    // executed) — hydrate the review table so the operator can authorize.
    if (params.get("draft") === "1") {
      const draft = takeBatchDraft();
      if (draft && draft.rows.length > 0) {
        const timeout = setTimeout(() => {
          setRows(screenRows(draft.rows));
          toast.success(`Prepared ${draft.rows.length} rows from ${draft.fileName} — review and authorize`);
        }, 0);
        return () => clearTimeout(timeout);
      }
    }

    const corridor = params.get("corridor")?.toUpperCase();
    if (!corridor) return;
    const matchingRows = sampleCsvRows.filter((row) => row.country === corridor || (corridor === "PHP" && row.country === "PH"));
    const timeout = setTimeout(() => setRows(screenRows(matchingRows)), 0);
    return () => clearTimeout(timeout);
  }, []);

  const pollBatch = useCallback(async (id: string) => {
    try {
      const res = await fetch(`/api/batches/${id}`);
      if (res.ok) {
        const data = (await res.json()) as BatchStatus;
        setBatchStatus(data);
        return data.state;
      }
    } catch {
      // silently ignore poll errors
    }
    return null;
  }, []);

  useEffect(() => {
    if (!batchId) return;
    const timeout = setTimeout(() => void pollBatch(batchId), 0);
    const interval = setInterval(async () => {
      const state = await pollBatch(batchId);
      if (state === 'SETTLED' || state === 'FAILED' || state === 'REFUNDED') {
        clearInterval(interval);
      }
    }, 2000);
    return () => {
      clearTimeout(timeout);
      clearInterval(interval);
    };
  }, [batchId, pollBatch]);

  const acceptedRows = useMemo(() => rows.filter((row) => row.status === "ready" || row.status === "queued"), [rows]);
  const reviewRows = useMemo(() => rows.filter((row) => row.status === "review"), [rows]);
  const blockedRows = useMemo(() => rows.filter((row) => row.status === "blocked" || row.status === "failed"), [rows]);
  const total = useMemo(() => rows.reduce((sum, row) => sum + (Number.parseFloat(row.amount) || 0), 0), [rows]);
  const acceptedTotal = useMemo(() => acceptedRows.reduce((sum, row) => sum + (Number.parseFloat(row.amount) || 0), 0), [acceptedRows]);
  const estimatedFees = acceptedTotal > 0 ? acceptedTotal * 0.014 + 4.5 : 0;

  function onFile(file: File) {
    Papa.parse<CsvRow>(file, {
      header: true,
      skipEmptyLines: true,
      complete: ({ data }) => {
        const normalized = data
          .filter((row) => row.address || row.name || row.amount)
          .map((row) => ({
            name: String(row.name ?? "").trim(),
            address: String(row.address ?? "").trim(),
            country: String(row.country ?? "PH").trim().toUpperCase(),
            purpose: String(row.purpose ?? "").trim(),
            amount: String(row.amount ?? "0").trim(),
          }));
        const screened = screenRows(normalized);

        setRows(screened);
        setBatchId(null);
        toast.success(`${screened.length} rows screened`);
      },
      error: (error) => toast.error(error.message),
    });
  }

  function downloadSampleCsv() {
    const csv = buildSampleCsv();
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "splash-batch-sample.csv";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
    toast.success("Sample CSV downloaded");
  }

  async function submitBatch() {
    if (!/^\d{6}$/.test(totp)) {
      toast.error("Enter your 6-digit authorization code");
      return;
    }

    if (acceptedRows.length === 0) {
      toast.error("No rows are cleared for authorization");
      return;
    }

    setBusy(true);

    try {
      const response = await fetch("/api/batches/authorize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rows: acceptedRows, totp }),
      });

      if (!response.ok) {
        const body = (await response.json()) as { error?: string };
        throw new Error(body.error ?? "Batch authorization failed");
      }

      const body = (await response.json()) as { id: string; blockedRows: number };
      setBatchId(body.id);
      setRows((current) => current.map((row) => (row.status === "ready" ? { ...row, status: "queued" } : row)));
      toast.success(body.blockedRows > 0 ? "Cleared rows queued with exceptions" : "Batch queued");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Batch failed";
      toast.error(message);
      setRows((current) => current.map((row) => (row.status === "ready" ? { ...row, status: "failed" } : row)));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto w-full max-w-6xl space-y-5">
      <DashPageHeader
        kicker="Batch operations"
        title="Upload, screen, authorize"
        description={
          <>
            Upload a CSV with columns <code className="font-mono">name,address,amount,country,purpose</code>. Splash preflights AML, KYT, limits, corridor &amp; purpose-code checks before TOTP authorization.
          </>
        }
        actions={
          <div className="rounded-xl border border-[#326273]/10 bg-white px-3 py-2 text-xs font-semibold text-[#326273]">
            Tier 1 limits · RM 20k / transfer
          </div>
        }
      />

      <SettlementEngineFlow variant="batch" className="dash-reveal" />

      <section className="grid gap-4 dash-reveal-stagger md:grid-cols-4">
        <HoverPopup title="Rows cleared" content="Beneficiaries that passed all AML, KYT, corridor, and purpose-code checks. These rows will be included in the batch authorization.">
          <SummaryCard icon={ShieldCheck} label="Rows cleared" value={String(acceptedRows.length)} tone="text-[#5C9EAD]" />
        </HoverPopup>
        <HoverPopup title="Manual review" content="Rows requiring manual attention. Usually missing purpose codes or above Tier 1 limits. These will not be included until resolved.">
          <SummaryCard icon={AlertTriangle} label="Manual review" value={String(reviewRows.length)} tone="text-[#E39774]" />
        </HoverPopup>
        <HoverPopup title="Blocked" content="Rows that failed compliance checks. Common reasons: sanctions/PEP hits, unsupported corridors, or invalid amounts.">
          <SummaryCard icon={XCircle} label="Blocked" value={String(blockedRows.length)} tone="text-red-600" />
        </HoverPopup>
        <HoverPopup title="Cleared amount" content="Total USD value of cleared rows. This is the amount that will be authorized and queued for settlement.">
          <SummaryCard icon={CheckCircle2} label="Cleared amount" value={`$${acceptedTotal.toFixed(2)}`} tone="text-[#5C9EAD]" />
        </HoverPopup>
      </section>

      <label className="flex cursor-pointer flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed border-[#5C9EAD]/40 bg-white/50 p-8 text-center transition-colors hover:border-[#5C9EAD] hover:bg-[#5C9EAD]/5 md:p-10">
        <Upload className="text-[#5C9EAD]" />
        <span className="font-semibold text-[#326273]">{rows.length ? `${rows.length} rows loaded — upload another CSV to replace` : "Click to upload CSV"}</span>
        <span className="text-xs text-[#326273]/50">Supported corridors: MY, PH, ID, SG, VN, TH, EU, GB · Amounts in USD</span>
        <input type="file" accept=".csv" className="hidden" onChange={(event) => event.target.files?.[0] && onFile(event.target.files[0])} />
      </label>

      <section className="grid gap-4 lg:grid-cols-[1.2fr_0.8fr]">
        <div className="dash-surface overflow-hidden">
          <div className="flex flex-col gap-3 border-b border-[#326273]/10 p-5 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="text-lg font-bold text-[#326273]">CSV format example</h2>
              <p className="mt-1 text-xs text-[#326273]/60">
                Columns are <code className="font-mono text-[11px]">name,address,country,purpose,amount</code>. Amounts in USD, country is ISO-2.
              </p>
            </div>
            <button
              type="button"
              onClick={downloadSampleCsv}
              className="inline-flex items-center justify-center gap-2 rounded-lg bg-[#5C9EAD] px-3 py-2 text-xs font-bold text-white hover:bg-[#264e5b]"
            >
              <Download className="h-3.5 w-3.5" />
              Download sample
            </button>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-xs">
              <thead className="bg-[#326273]/5">
                <tr className="text-left text-[#326273]/65">
                  <th className="p-3 font-bold uppercase tracking-wide">name</th>
                  <th className="p-3 font-bold uppercase tracking-wide">address</th>
                  <th className="p-3 font-bold uppercase tracking-wide">country</th>
                  <th className="p-3 font-bold uppercase tracking-wide">purpose</th>
                  <th className="p-3 text-right font-bold uppercase tracking-wide">amount</th>
                </tr>
              </thead>
              <tbody>
                {sampleCsvRows.map((row) => (
                  <tr key={row.address} className="border-t border-[#326273]/5">
                    <td className="p-3 font-medium text-[#326273]">{row.name}</td>
                    <td className="p-3 font-mono text-[11px] text-[#326273]/70">{row.address}</td>
                    <td className="p-3 font-semibold text-[#326273]">{row.country}</td>
                    <td className="p-3 text-[#326273]/70">{row.purpose}</td>
                    <td className="p-3 text-right font-mono text-[#326273]">$ {row.amount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="border-t border-[#326273]/10 bg-[#F6F0ED]/60 p-4">
            <div className="text-[10px] font-bold uppercase tracking-[0.16em] text-[#326273]/55">Raw CSV</div>
            <pre className="mt-2 overflow-x-auto rounded-lg bg-[#1F4452] p-3 font-mono text-[11px] leading-5 text-[#F6F0ED]">{`${csvHeader}
${sampleCsvRows.map((row) => `${row.name},${row.address},${row.country},${row.purpose},${row.amount}`).join("\n")}`}</pre>
          </div>
        </div>

        <div className="dash-surface p-5">
          <div className="mb-4">
            <h2 className="text-lg font-bold text-[#326273]">Why batch payout wins</h2>
            <p className="mt-1 text-xs text-[#326273]/60">Concrete reasons treasury teams move payroll and vendor runs through Splash batches.</p>
          </div>
          <div className="space-y-3">
            {batchBenefits.map(({ icon: Icon, title, body }) => (
              <div key={title} className="flex items-start gap-3 rounded-xl bg-[#F6F0ED] p-3 transition-colors hover:bg-[#5C9EAD]/10">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-white text-[#5C9EAD]">
                  <Icon className="h-4 w-4" />
                </div>
                <div className="min-w-0">
                  <div className="text-sm font-bold text-[#326273]">{title}</div>
                  <p className="mt-0.5 text-[11px] leading-5 text-[#326273]/65">{body}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {rows.length > 0 && (
        <>
          <section className="grid gap-4 lg:grid-cols-[1.2fr_0.8fr]">
            <div className="dash-surface overflow-hidden">
              <div className="border-b border-[#326273]/10 p-5">
                <h2 className="text-xl font-bold text-[#326273]">Preflight results</h2>
                <p className="mt-1 text-sm text-[#326273]/60">Only rows marked cleared are included in this authorization request.</p>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[860px] text-sm">
                  <thead className="bg-[#326273]/5">
                    <tr className="text-left text-[#326273]/70">
                      <th className="p-3">Beneficiary</th>
                      <th>Corridor</th>
                      <th>Purpose</th>
                      <th className="text-right">Amount</th>
                      <th>AML / KYT</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row) => {
                      const result = strongestResult(row.checks);

                      return (
                        <tr key={`${row.address}-${row.amount}-${row.name}`} className="border-t border-[#326273]/5">
                          <td className="p-3">
                            <div className="font-medium text-[#326273]">{row.name || "Unnamed beneficiary"}</div>
                            <div className="mt-1 font-mono text-xs text-[#326273]/50">{row.address || "Missing reference"}</div>
                          </td>
                          <td className="font-semibold text-[#326273]">USD → {row.country || "—"}</td>
                          <td className="text-[#326273]/70">{row.purpose || "Needs purpose code"}</td>
                          <td className="text-right font-mono text-[#326273]">$ {Number.parseFloat(row.amount || "0").toFixed(2)}</td>
                          <td>
                            <div className={`inline-flex rounded-full border px-3 py-1 text-xs font-bold ${badgeClass(result)}`}>{result}</div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="space-y-4">
              <div className="dash-surface p-5">
                <h2 className="text-xl font-bold text-[#326273]">Authorization summary</h2>
                <div className="mt-4 space-y-3 text-sm">
                  <Row label="Uploaded total" value={`$${total.toFixed(2)}`} />
                  <Row label="Cleared total" value={`$${acceptedTotal.toFixed(2)}`} />
                  <Row label="Estimated fees" value={`$${estimatedFees.toFixed(2)}`} />
                  <Row label="Rows excluded" value={`${reviewRows.length + blockedRows.length}`} />
                </div>
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    void submitBatch();
                  }}
                  className="mt-5 flex items-center gap-3"
                >
                  <input
                    inputMode="numeric"
                    maxLength={6}
                    value={totp}
                    onChange={(event) => setTotp(event.target.value.replace(/\D/g, "").slice(0, 6))}
                    className="w-32 rounded-lg border border-[#326273]/20 bg-[#F6F0ED] px-3 py-3 text-center font-mono tracking-[0.25em] text-[#326273] focus:border-[#5C9EAD] focus:outline-none"
                    placeholder="000000"
                  />
                  <button type="submit" disabled={busy || acceptedRows.length === 0 || totp.length !== 6} className="flex-1 rounded-lg bg-[#E39774] px-6 py-3 font-bold text-white hover:bg-[#cd825f] disabled:opacity-50">
                    {busy ? <span className="inline-flex items-center gap-2"><Loader2 className="animate-spin" size={16} /> Queueing…</span> : "Authorize cleared rows"}
                  </button>
                </form>
                {batchStatus && <BatchStatusPanel status={batchStatus} />}
              </div>

              <div className="dash-surface p-5">
                <h2 className="text-xl font-bold text-[#326273]">AML / KYT controls</h2>
                <div className="mt-4 space-y-3">
                  <Control label="Sanctions / PEP" detail="Screens every beneficiary before authorization." />
                  <Control label="KYT amount threshold" detail="Flags transfers above Tier 1 review limits." />
                  <Control label="Structuring detection" detail="Flags repeated beneficiary patterns in one file." />
                  <Control label="Purpose-code capture" detail="Required for release to settlement queue." />
                </div>
              </div>
            </div>
          </section>

          {(reviewRows.length > 0 || blockedRows.length > 0) && (
            <section className="rounded-2xl border border-[#E39774]/30 bg-[#E39774]/10 p-5">
              <div className="flex gap-3">
                <FileWarning className="mt-0.5 text-[#E39774]" />
                <div>
                  <h2 className="font-bold text-[#326273]">Exceptions require review</h2>
                  <p className="mt-1 text-sm text-[#326273]/70">Rows marked REVIEW need a purpose-code, limit, or KYT review. Rows marked BLOCK are excluded until compliance clears the beneficiary or corridor.</p>
                </div>
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}

const BATCH_STEPS = ['QUEUED', 'SETTLING', 'SETTLED'];

function BatchStatusPanel({ status }: { status: BatchStatus }) {
  const isDone = status.state === 'SETTLED';
  const isFailed = status.state === 'FAILED' || status.state === 'REFUNDED' || status.state === 'REFUNDING';
  const currentStep = BATCH_STEPS.indexOf(status.state);

  return (
    <div className="mt-4 rounded-xl border border-[#326273]/10 bg-[#F6F0ED] p-4 space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-bold uppercase tracking-wide text-[#326273]/60">Batch status</span>
        {isDone ? (
          <span className="inline-flex items-center gap-1 rounded-full bg-[#5C9EAD]/10 px-2.5 py-0.5 text-xs font-bold text-[#5C9EAD]">
            <CheckCircle2 size={11} /> SETTLED
          </span>
        ) : isFailed ? (
          <span className="inline-flex items-center gap-1 rounded-full bg-red-100 px-2.5 py-0.5 text-xs font-bold text-red-600">
            <XCircle size={11} /> {status.state}
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 rounded-full bg-[#326273]/10 px-2.5 py-0.5 text-xs font-bold text-[#326273]/70">
            <Loader2 size={11} className="animate-spin" /> {status.state}
          </span>
        )}
      </div>

      {!isFailed && (
        <div className="flex items-center gap-1">
          {BATCH_STEPS.map((step, i) => {
            const done = currentStep === -1 ? isDone : i < currentStep;
            const active = i === currentStep;
            return (
              <div key={step} className="flex shrink-0 items-center gap-1">
                <div className={`flex h-5 items-center justify-center rounded-full px-2 text-[10px] font-bold transition-colors
                    ${done ? 'bg-[#5C9EAD] text-white' : active ? 'border-2 border-[#5C9EAD] bg-white text-[#5C9EAD]' : 'bg-[#326273]/10 text-[#326273]/40'}`}>
                  {done ? '✓' : step}
                </div>
                {i < BATCH_STEPS.length - 1 && (
                  <div className={`h-0.5 w-4 rounded-full ${done ? 'bg-[#5C9EAD]' : 'bg-[#326273]/10'}`} />
                )}
              </div>
            );
          })}
        </div>
      )}

      <div className="font-mono text-[11px] text-[#326273]/50 break-all">ID: {status.id}</div>

      {status.digest && (() => {
        const isSimulated = status.demo === true || status.digest.startsWith("SIM_");
        return (
          <div className="flex flex-wrap items-center gap-2">
            <div className="min-w-0 flex-1 break-all rounded-lg bg-white px-3 py-1.5 font-mono text-[11px] text-[#326273]/60">
              {status.digest}
            </div>
            {isSimulated ? (
              <span className="inline-flex items-center gap-2">
                <StatusBadge status="demo" />
                <span className="text-[11px] font-semibold text-[#9a6f15]">Simulated batch — no on-chain transaction</span>
              </span>
            ) : (
              <ExplorerLinks digest={status.digest} />
            )}
          </div>
        );
      })()}

      <div className="flex items-center gap-3 text-[11px] text-[#326273]/50">
        <Clock size={11} />
        <span>{status.acceptedRows} rows · $ {status.totalAmount}</span>
        {!isDone && !isFailed && <Loader2 size={11} className="animate-spin ml-auto" />}
      </div>
    </div>
  );
}

function SummaryCard({ icon: Icon, label, value, tone }: { icon: LucideIcon; label: string; value: string; tone: string }) {
  return (
    <DashStat
      className="cursor-pointer p-5"
      label={label}
      value={value}
      icon={Icon}
      iconClassName={tone}
      iconWrapClassName="bg-transparent p-0"
    />
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4">
      <span className="text-[#326273]/60">{label}</span>
      <span className="font-semibold text-[#326273]">{value}</span>
    </div>
  );
}

function Control({ label, detail }: { label: string; detail: string }) {
  return (
    <HoverPopup title={label} content={detail}>
      <div className="cursor-pointer rounded-xl bg-[#F6F0ED] p-4 transition-all hover:shadow-md hover:shadow-[#5C9EAD]/10">
        <div className="flex items-center gap-2 font-semibold text-[#326273]">
          <CheckCircle2 className="text-[#5C9EAD]" size={16} />
          {label}
        </div>
        <div className="mt-1 text-xs text-[#326273]/60">{detail}</div>
      </div>
    </HoverPopup>
  );
}
