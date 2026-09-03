'use client';

import { useState, useTransition } from 'react';
import { Check, Copy, ExternalLink, RotateCcw } from 'lucide-react';

type Field = {
  key: string;
  label: string;
  envKey: string;
  placeholder: string;
  help?: string;
};

const FIELDS: Field[] = [
  { key: 'packageId', label: 'Package ID', envKey: 'SPLASH_PACKAGE_ID', placeholder: '0x…', help: '64-hex Sui package address from `sui client publish`.' },
  { key: 'treasuryId', label: 'Treasury / Settlement Pool', envKey: 'SPLASH_TREASURY_ID', placeholder: '0x…', help: 'SettlementPool<SUI> object created on deploy.' },
  { key: 'adminCapId', label: 'Admin Cap', envKey: 'SPLASH_ADMIN_CAP_ID', placeholder: '0x…', help: 'business_account::AdminCap object owned by the operator wallet.' },
  { key: 'pegStateId', label: 'Peg State', envKey: 'SPLASH_PEG_STATE_ID', placeholder: '0x…', help: 'peg_monitor::PegState shared object.' },
  { key: 'complianceConfigId', label: 'Compliance Config', envKey: 'SPLASH_COMPLIANCE_CONFIG_ID', placeholder: '0x…', help: 'Shared Pyth staleness, deviation, DeepBook slippage, depth, and pause controls.' },
  { key: 'complianceCapId', label: 'Compliance Cap', envKey: 'SPLASH_COMPLIANCE_CAP_ID', placeholder: '0x…', help: 'Owned capability required to update settlement risk thresholds.' },
  { key: 'deepbookPoolId', label: 'DeepBook V3 Pool', envKey: 'DEEPBOOK_POOL_ID', placeholder: '0x…', help: 'Independent amount-sized liquidity source used by the Move settlement guard.' },
  { key: 'businessAccountId', label: 'Business Account', envKey: 'SPLASH_BUSINESS_ACCOUNT_ID', placeholder: '0x…', help: 'business_account::BusinessAccount shared object.' },
  { key: 'transferCoinId', label: 'Transfer Coin (test)', envKey: 'SPLASH_TRANSFER_COIN_ID', placeholder: '0x…', help: 'Optional. SUI coin object pre-funded for test transfers.' },
  { key: 'settlementRegistryId', label: 'Settlement Registry', envKey: 'SPLASH_SETTLEMENT_REGISTRY_ID', placeholder: '0x… (optional)' },
  { key: 'testRecipientAddress', label: 'Test Recipient Address', envKey: 'SPLASH_TEST_RECIPIENT_ADDRESS', placeholder: '0x…', help: 'When set, single + batch settlements route to this address (override).' },
  { key: 'operatorAddress', label: 'Operator Address', envKey: 'OPERATOR_SUI_ADDRESS', placeholder: '0x…' },
  { key: 'treasuryAddress', label: 'Treasury Address', envKey: 'TREASURY_ADDRESS', placeholder: '0x…' },
  { key: 'usdcType', label: 'USDC Type', envKey: 'USDC_TYPE', placeholder: '0x2::sui::SUI' },
  { key: 'usdtType', label: 'USDT Type', envKey: 'USDT_TYPE', placeholder: '0xpkg::usdt::USDT (optional)' },
  { key: 'usdtBufferId', label: 'USDT Buffer ID', envKey: 'USDT_BUFFER_ID', placeholder: '0x… (optional)' },
  { key: 'deepbookQuoteType', label: 'DeepBook Quote Type', envKey: 'DEEPBOOK_QUOTE_TYPE', placeholder: '0xpkg::usdc::USDC', help: 'Quote asset paired with USDC_TYPE in the configured DeepBook V3 pool.' },
  { key: 'smartTreasurySuiId', label: 'Smart Treasury (SUI)', envKey: 'SPLASH_SMART_TREASURY_SUI_ID', placeholder: '0x…', help: 'Shared smart_treasury::SmartTreasury<0x2::sui::SUI> used by the composed payment allocation leg.' },
];

type Meta = { path: string; exists: boolean; updatedAt: string | null };

type Props = {
  initialConfig: Record<string, string>;
  initialEnv: Record<string, string>;
  initialMeta: Meta;
  network: string;
};

export default function ContractConfigForm({ initialConfig, initialEnv, initialMeta, network }: Props) {
  const [values, setValues] = useState<Record<string, string>>(initialConfig);
  const [env] = useState(initialEnv);
  const [meta, setMeta] = useState<Meta>(initialMeta);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<{ kind: 'idle' } | { kind: 'success'; at: string } | { kind: 'error'; message: string }>({ kind: 'idle' });
  const [copied, setCopied] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function update(key: string, value: string) {
    setValues((prev) => ({ ...prev, [key]: value }));
    setErrors((prev) => {
      if (!prev[key]) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
    if (status.kind !== 'idle') setStatus({ kind: 'idle' });
  }

  function revertToEnv(key: string) {
    update(key, env[key] ?? '');
  }

  async function copyValue(key: string, value: string) {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      setCopied(key);
      setTimeout(() => setCopied((c) => (c === key ? null : c)), 1200);
    } catch {}
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setStatus({ kind: 'idle' });
    setErrors({});
    startTransition(async () => {
      try {
        const response = await fetch('/api/admin/contracts', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(values),
        });
        const data = await response.json();
        if (!response.ok) {
          setErrors(data.fields ?? {});
          setStatus({ kind: 'error', message: data.error ?? 'Failed to save.' });
          return;
        }
        setValues(data.config);
        setMeta(data.meta);
        setStatus({ kind: 'success', at: new Date().toLocaleTimeString() });
      } catch (error) {
        setStatus({ kind: 'error', message: error instanceof Error ? error.message : 'Network error' });
      }
    });
  }

  return (
    <form onSubmit={submit} className="space-y-5">
      <div className="rounded-[2rem] border border-[#326273]/10 bg-white p-6 shadow-sm md:p-8">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="inline-flex rounded-full bg-[#5C9EAD]/10 px-3 py-1 text-xs font-bold uppercase tracking-wide text-[#5C9EAD]">{network}</div>
            <h1 className="mt-3 text-3xl font-black tracking-[-0.04em] text-[#1f4350]">Contract config</h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-[#326273]/65">
              On-chain object IDs used by settlement, peg refresh, and business-account flows. Changes apply immediately to new requests — no server restart needed. The previous{' '}
              <code className="rounded bg-[#F6F0ED] px-1 py-0.5 text-xs">.env.local</code> values remain as the fallback.
            </p>
          </div>
          <div className="rounded-2xl border border-[#326273]/10 bg-[#F6F0ED] px-4 py-3 text-xs leading-5 text-[#326273]/80">
            <div><span className="font-bold text-[#1f4350]">File:</span> {meta.path}</div>
            <div className="mt-1"><span className="font-bold text-[#1f4350]">Status:</span> {meta.exists ? `Override active${meta.updatedAt ? ` — updated ${new Date(meta.updatedAt).toLocaleString()}` : ''}` : 'No override (using env)'}</div>
          </div>
        </div>
      </div>

      <div className="rounded-[2rem] border border-[#326273]/10 bg-white p-6 shadow-sm md:p-8">
        <div className="grid gap-5 md:grid-cols-2">
          {FIELDS.map((field) => {
            const current = values[field.key] ?? '';
            const envValue = env[field.key] ?? '';
            const overridden = current !== envValue && envValue !== '';
            const error = errors[field.key];
            return (
              <div key={field.key} className="space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <label htmlFor={field.key} className="text-sm font-bold text-[#1f4350]">
                    {field.label}
                  </label>
                  <code className="text-[10px] uppercase tracking-[0.16em] text-[#326273]/55">{field.envKey}</code>
                </div>
                <div className="relative">
                  <input
                    id={field.key}
                    type="text"
                    value={current}
                    onChange={(e) => update(field.key, e.target.value)}
                    placeholder={field.placeholder}
                    spellCheck={false}
                    autoComplete="off"
                    className={`w-full rounded-2xl border px-4 py-3 pr-20 font-mono text-xs text-[#1f4350] focus:outline-none focus:ring-2 focus:ring-[#5C9EAD]/40 ${error ? 'border-red-400 bg-red-50' : 'border-[#326273]/15 bg-white'}`}
                  />
                  <div className="absolute right-2 top-1/2 flex -translate-y-1/2 items-center gap-1">
                    {envValue && (
                      <button
                        type="button"
                        title={`Revert to env: ${envValue.slice(0, 14)}…`}
                        onClick={() => revertToEnv(field.key)}
                        className="rounded-lg p-1.5 text-[#326273]/55 hover:bg-[#F6F0ED] hover:text-[#326273]"
                      >
                        <RotateCcw className="h-3.5 w-3.5" />
                      </button>
                    )}
                    <button
                      type="button"
                      title="Copy value"
                      onClick={() => copyValue(field.key, current)}
                      className="rounded-lg p-1.5 text-[#326273]/55 hover:bg-[#F6F0ED] hover:text-[#326273]"
                    >
                      {copied === field.key ? <Check className="h-3.5 w-3.5 text-green-600" /> : <Copy className="h-3.5 w-3.5" />}
                    </button>
                  </div>
                </div>
                {error && <p className="text-xs text-red-600">{error}</p>}
                {!error && field.help && <p className="text-xs leading-5 text-[#326273]/55">{field.help}</p>}
                {overridden && (
                  <p className="text-[11px] leading-4 text-[#5C9EAD]">
                    Override active (env: <code className="font-mono">{envValue.slice(0, 18)}…</code>)
                  </p>
                )}
                {current && /^0x[a-fA-F0-9]{64}$/.test(current) && (
                  <a
                    href={`https://${network}.suivision.xyz/object/${current}`}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 text-[11px] font-semibold text-[#5C9EAD] hover:underline"
                  >
                    SuiVision <ExternalLink className="h-3 w-3" />
                  </a>
                )}
              </div>
            );
          })}
        </div>
      </div>

      <div className="sticky bottom-4 flex items-center justify-between gap-3 rounded-[2rem] border border-[#326273]/10 bg-white p-4 shadow-md">
        <div className="text-xs text-[#326273]/65">
          {status.kind === 'success' && <span className="font-semibold text-green-700">Saved at {status.at}. New requests use these values immediately.</span>}
          {status.kind === 'error' && <span className="font-semibold text-red-600">{status.message}</span>}
          {status.kind === 'idle' && <span>Changes are written to <code className="rounded bg-[#F6F0ED] px-1 py-0.5">data/contract-config.json</code>.</span>}
        </div>
        <button
          type="submit"
          disabled={pending}
          className="rounded-xl bg-[#1f4350] px-5 py-2.5 text-sm font-bold text-white shadow-sm transition hover:bg-[#326273] disabled:opacity-60"
        >
          {pending ? 'Saving…' : 'Save changes'}
        </button>
      </div>
    </form>
  );
}
