import { listBatches, listTransfers, listTransactions } from '@/lib/server/operations';
import { pythAdapter } from '@/lib/server/pyth';
import { readComplianceControls } from '@/lib/server/sui-settlement';
import ComplianceControlForm from '@/components/admin/ComplianceControlForm';
import { Activity, CheckCircle2, Circle, ExternalLink, Loader2, ReceiptText, XCircle } from 'lucide-react';
import { listFundingSessions } from '@/lib/server/funding-sessions';
import { describeFundingSelection } from '@/lib/funding/registry';

export const dynamic = 'force-dynamic';

export default async function AdminTransactionsPage() {
  const batches = listBatches();
  const transfers = listTransfers();
  const transactions = listTransactions();
  const fundingSessions = listFundingSessions();
  const pegStatus = await pythAdapter.getPegStatus();
  const complianceControls = await readComplianceControls();
  const usdcDevBps = Math.abs(pegStatus.usdcUsd.price - 1.0) * 10_000;
  const usdtDevBps = Math.abs(pegStatus.usdtUsd.price - 1.0) * 10_000;
  const maxDev = Math.max(usdcDevBps, usdtDevBps);
  // DeepBook (primary) drives the zone; fall back to Pyth deviation if unavailable.
  const primaryDevBps = pegStatus.deepbook ? pegStatus.deepbook.deviationBps : maxDev;
  const zone = !pegStatus.pegged ? 'red' : primaryDevBps > 30 ? 'yellow' : 'green';
  const volume = transfers.reduce((sum, transfer) => sum + Number.parseFloat(transfer.sourceAmountUsd || '0'), 0);
  const fees = volume * 0.015;

  return (
    <div className="mx-auto max-w-7xl space-y-6">
      <header className="dash-surface p-6 md:p-8">
        <span className="dash-kicker">Settlement monitor</span>
        <h1 className="dash-title mt-2 text-4xl">Live transfer feed</h1>
        <p className="mt-3 max-w-3xl text-sm leading-6 text-[#326273]/65">Monitor peg health, cross-border volume, fee capture, and Sui settlement transactions linked to the active package.</p>
      </header>

      <section className="grid gap-5 md:grid-cols-3">
        <MonitorCard icon={Circle} label="Peg Status" value={`${zone === 'green' ? '🟢' : zone === 'yellow' ? '🟡' : '🔴'} ${zone[0].toUpperCase()}${zone.slice(1)}`} detail={`DeepBook ${pegStatus.deepbook ? `${pegStatus.deepbook.midPrice.toFixed(4)} (${pegStatus.deepbook.deviationBps.toFixed(1)} bps)` : 'n/a'} · Pyth USDC ${usdcDevBps.toFixed(1)}/USDT ${usdtDevBps.toFixed(1)} bps · ${pegStatus.confirmedBy}/2 confirm`} />
        <MonitorCard icon={Activity} label="24h Volume" value={`RM ${volume.toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`} detail={`${transfers.length} transfer intents`} />
        <MonitorCard icon={ReceiptText} label="Fees" value={`RM ${fees.toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`} detail="Estimated at 1.5% headline" />
      </section>

      <ComplianceControlForm initial={complianceControls} />

      <div className="dash-surface">
        <div className="border-b border-[#326273]/10 p-5">
          <h2 className="text-lg font-bold text-[#1f4350]">Funding intake and KYT</h2>
          <p className="mt-1 text-xs text-[#326273]/60">Deposits stay outside the available balance until KYT and normalization complete.</p>
        </div>
        {fundingSessions.length === 0 ? (
          <div className="p-8 text-center text-sm text-[#326273]/60">No funding sessions yet.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[1050px] text-sm">
              <thead className="bg-[#326273]/5">
                <tr className="text-left text-[#326273]/70">
                  <th className="p-3">Session</th>
                  <th>Status</th>
                  <th>Source</th>
                  <th>Detail</th>
                  <th>KYT</th>
                  <th>Normalize</th>
                  <th>Fee tier</th>
                  <th>Operator flag</th>
                </tr>
              </thead>
              <tbody>
                {fundingSessions.map((session) => (
                  <tr key={session.id} className="border-t border-[#326273]/5">
                    <td className="p-3 font-mono text-xs text-[#326273]">{session.id}</td>
                    <td><span className={`rounded-full px-2.5 py-1 text-xs font-bold ${session.status === 'QUARANTINED' ? 'bg-[#E39774]/20 text-[#9b4e32]' : session.status === 'CREDITED' || session.status === 'CLEARED' ? 'bg-[#5C9EAD]/15 text-[#326273]' : 'bg-[#F6F0ED] text-[#326273]'}`}>{session.status}</span></td>
                    <td className="font-semibold text-[#326273]">{session.selection.source}</td>
                    <td className="text-[#326273]">{describeFundingSelection(session.selection)}</td>
                    <td className="text-[#326273]">{session.kytPolicy ?? '-'}{session.sourceType ? ` / ${session.sourceType}` : ''}</td>
                    <td className="font-mono text-xs text-[#326273]">{session.normalizeVenue ?? '-'}{session.effectiveSlippageBps !== undefined ? ` / ${session.effectiveSlippageBps} bps` : ''}</td>
                    <td className="font-bold text-[#326273]">{session.feeTier}</td>
                    <td className="max-w-64 text-xs text-[#9b4e32]">{session.adminFlag ?? session.kytReasons?.join('; ') ?? '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="dash-surface">
        <div className="border-b border-[#326273]/10 p-5">
          <h2 className="text-lg font-bold text-[#1f4350]">Live Transfer Feed</h2>
        </div>
        <div className="divide-y divide-[#326273]/10">
          {transfers.slice(0, 8).map((transfer) => (
            <div key={transfer.id} className="grid gap-3 p-4 text-sm md:grid-cols-[120px_1fr_auto] md:items-center">
              <div className="text-xs font-semibold text-[#326273]/65">{new Date(transfer.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</div>
              <div className="font-mono font-semibold text-[#1f4350]">$ {transfer.sourceAmountUsd} → {transfer.targetAmount} {transfer.targetCurrency}</div>
              <div className="rounded-full bg-[#F6F0ED] px-3 py-1 text-xs font-bold text-[#326273]">{transfer.state}</div>
            </div>
          ))}
          {transfers.length === 0 && <div className="p-8 text-center text-sm text-[#326273]/65">No transfers yet.</div>}
        </div>
      </div>

      <div className="dash-surface">
        <div className="border-b border-[#326273]/10 p-5">
          <h2 className="text-lg font-bold text-[#326273]">Single transfers</h2>
        </div>
        {transfers.length === 0 ? (
          <div className="p-8 text-center text-sm text-[#326273]/60">No single transfers yet.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[1050px] text-sm">
              <thead className="bg-[#326273]/5">
                <tr className="text-left text-[#326273]/70">
                  <th className="p-3">Transfer ID</th>
                  <th>State</th>
                  <th>Recipient</th>
                  <th>Source</th>
                  <th>Fee tier</th>
                  <th className="text-right">Amount</th>
                  <th>Digest</th>
                  <th>Explorer</th>
                  <th>Time</th>
                </tr>
              </thead>
              <tbody>
                {transfers.map((transfer) => (
                  <tr key={transfer.id} className="border-t border-[#326273]/5">
                    <td className="p-3 font-mono text-xs text-[#326273]">{transfer.id}</td>
                    <td>
                      <div className="flex items-center gap-2">
                        {transfer.state === 'SETTLED' && <CheckCircle2 className="text-[#5C9EAD]" size={14} />}
                        {transfer.state === 'SETTLING' && <Loader2 className="animate-spin text-[#E39774]" size={14} />}
                        {transfer.state === 'QUEUED' && <Loader2 className="animate-spin text-[#326273]/60" size={14} />}
                        {transfer.state === 'FAILED' && <XCircle className="text-red-500" size={14} />}
                        <span className="font-semibold text-[#326273]">{transfer.state}</span>
                      </div>
                    </td>
                    <td className="text-[#326273]">{transfer.recipientName}</td>
                    <td className="font-semibold text-[#326273]">{transfer.fundingSource}</td>
                    <td className="font-bold text-[#326273]">{transfer.fundingFeeTier}</td>
                    <td className="text-right font-mono text-[#326273]">{transfer.targetAmount} {transfer.targetCurrency}</td>
                    <td className="font-mono text-xs text-[#326273]/70">{transfer.verificationReference || '—'}</td>
                    <td>
                      {transfer.verificationReference && (
                        <div className="flex gap-1">
                          <a href={`https://testnet.suivision.xyz/txblock/${transfer.verificationReference}`} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 rounded bg-[#5C9EAD]/10 px-2 py-1 text-xs font-semibold text-[#5C9EAD] hover:bg-[#5C9EAD]/20">
                            <ExternalLink size={10} />
                            SuiVision
                          </a>
                          <a href={`https://suiscan.xyz/testnet/tx/${transfer.verificationReference}`} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 rounded bg-[#5C9EAD]/10 px-2 py-1 text-xs font-semibold text-[#5C9EAD] hover:bg-[#5C9EAD]/20">
                            <ExternalLink size={10} />
                            SuiScan
                          </a>
                        </div>
                      )}
                    </td>
                    <td className="text-xs text-[#326273]/60">{new Date(transfer.createdAt).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="dash-surface">
        <div className="border-b border-[#326273]/10 p-5">
          <h2 className="text-lg font-bold text-[#326273]">Batch payouts</h2>
        </div>
        {batches.length === 0 ? (
          <div className="p-8 text-center text-sm text-[#326273]/60">No batch transactions yet.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[900px] text-sm">
              <thead className="bg-[#326273]/5">
                <tr className="text-left text-[#326273]/70">
                  <th className="p-3">Batch ID</th>
                  <th>State</th>
                  <th className="text-right">Rows</th>
                  <th className="text-right">Amount</th>
                  <th>Digest</th>
                  <th>Package</th>
                  <th>Explorer</th>
                  <th>Time</th>
                </tr>
              </thead>
              <tbody>
                {batches.map((batch) => (
                  <tr key={batch.id} className="border-t border-[#326273]/5">
                    <td className="p-3 font-mono text-xs text-[#326273]">{batch.id}</td>
                    <td>
                      <div className="flex items-center gap-2">
                        {batch.state === 'SETTLED' && <CheckCircle2 className="text-[#5C9EAD]" size={14} />}
                        {batch.state === 'SETTLING' && <Loader2 className="animate-spin text-[#E39774]" size={14} />}
                        {batch.state === 'QUEUED' && <Loader2 className="animate-spin text-[#326273]/60" size={14} />}
                        {batch.state === 'FAILED' && <XCircle className="text-red-500" size={14} />}
                        <span className="font-semibold text-[#326273]">{batch.state}</span>
                      </div>
                    </td>
                    <td className="text-right text-[#326273]">{batch.acceptedRows}</td>
                    <td className="text-right font-mono text-[#326273]">$ {batch.totalAmount}</td>
                    <td className="font-mono text-xs text-[#326273]/70">{batch.digest || '—'}</td>
                    <td className="font-mono text-xs text-[#326273]/70">{batch.packageId || '—'}</td>
                    <td>
                      <div className="flex gap-1">
                        {batch.explorer.suiVisionTxUrl && (
                          <a href={batch.explorer.suiVisionTxUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 rounded bg-[#5C9EAD]/10 px-2 py-1 text-xs font-semibold text-[#5C9EAD] hover:bg-[#5C9EAD]/20">
                            <ExternalLink size={10} />
                            SuiVision
                          </a>
                        )}
                        {batch.explorer.suiScanTxUrl && (
                          <a href={batch.explorer.suiScanTxUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 rounded bg-[#5C9EAD]/10 px-2 py-1 text-xs font-semibold text-[#5C9EAD] hover:bg-[#5C9EAD]/20">
                            <ExternalLink size={10} />
                            SuiScan
                          </a>
                        )}
                      </div>
                    </td>
                    <td className="text-xs text-[#326273]/60">{new Date(batch.createdAt).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="dash-surface">
        <div className="border-b border-[#326273]/10 p-5">
          <h2 className="text-lg font-bold text-[#326273]">All transactions</h2>
        </div>
        {transactions.length === 0 ? (
          <div className="p-8 text-center text-sm text-[#326273]/60">No transactions yet.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[1000px] text-sm">
              <thead className="bg-[#326273]/5">
                <tr className="text-left text-[#326273]/70">
                  <th className="p-3">ID</th>
                  <th>Kind</th>
                  <th>State</th>
                  <th>Module::function</th>
                  <th className="text-right">Amount</th>
                  <th>Digest</th>
                  <th>Package</th>
                  <th>Explorer</th>
                  <th>Time</th>
                </tr>
              </thead>
              <tbody>
                {transactions.map((tx) => (
                  <tr key={tx.id} className="border-t border-[#326273]/5">
                    <td className="p-3 font-mono text-xs text-[#326273]">{tx.id}</td>
                    <td className="font-semibold text-[#326273]">{tx.kind}</td>
                    <td>
                      <div className="flex items-center gap-2">
                        {tx.state === 'SETTLED' && <CheckCircle2 className="text-[#5C9EAD]" size={14} />}
                        {tx.state === 'SETTLING' && <Loader2 className="animate-spin text-[#E39774]" size={14} />}
                        {tx.state === 'QUEUED' && <Loader2 className="animate-spin text-[#326273]/60" size={14} />}
                        {tx.state === 'FAILED' && <XCircle className="text-red-500" size={14} />}
                        <span className="font-semibold text-[#326273]">{tx.state}</span>
                      </div>
                    </td>
                    <td className="font-mono text-xs text-[#326273]/70">
                      {tx.module}::{tx.functionName}
                    </td>
                    <td className="text-right font-mono text-[#326273]">{tx.amount}</td>
                    <td className="font-mono text-xs text-[#326273]/70">{tx.digest || '—'}</td>
                    <td className="font-mono text-xs text-[#326273]/70">{tx.packageId || '—'}</td>
                    <td>
                      <div className="flex gap-1">
                        {tx.explorer.suiVisionTxUrl && (
                          <a href={tx.explorer.suiVisionTxUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 rounded bg-[#5C9EAD]/10 px-2 py-1 text-xs font-semibold text-[#5C9EAD] hover:bg-[#5C9EAD]/20">
                            <ExternalLink size={10} />
                            SuiVision
                          </a>
                        )}
                        {tx.explorer.suiScanTxUrl && (
                          <a href={tx.explorer.suiScanTxUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 rounded bg-[#5C9EAD]/10 px-2 py-1 text-xs font-semibold text-[#5C9EAD] hover:bg-[#5C9EAD]/20">
                            <ExternalLink size={10} />
                            SuiScan
                          </a>
                        )}
                      </div>
                    </td>
                    <td className="text-xs text-[#326273]/60">{new Date(tx.createdAt).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function MonitorCard({ icon: Icon, label, value, detail }: { icon: typeof Circle; label: string; value: string; detail: string }) {
  return (
    <div className="dash-block p-6">
      <Icon className="h-5 w-5 text-[#5C9EAD]" />
      <div className="mt-4 text-[11px] font-bold uppercase tracking-wide text-[#326273]/55">{label}</div>
      <div className="mt-2 text-2xl font-black text-[#1f4350]">{value}</div>
      <div className="mt-1 text-sm text-[#326273]/65">{detail}</div>
    </div>
  );
}
