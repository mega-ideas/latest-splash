'use client';

import { useEffect, useRef, useState } from 'react';
import {
  Banknote,
  Building2,
  Check,
  CircleDollarSign,
  Coins,
  Landmark,
  Loader2,
  ShieldCheck,
  WalletCards,
} from 'lucide-react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type {
  CctpSourceChain,
  FundingRegistry,
  FundingSelection,
  FundingSourceId,
  FundingSourceOption,
  StablecoinAsset,
  StablecoinRail,
  UsdProviderId,
} from '@/lib/funding/registry';
import { cn } from '@/lib/utils';

type FundingOptions = FundingRegistry & {
  sources: FundingSourceOption[];
  defaultSource: FundingSourceId | null;
  defaultSelection: FundingSelection | null;
  heldBalanceMicro: number;
  heldBalanceUsdc: string;
  lastUsedSource: FundingSourceId | null;
  businessAccountId: string;
  suggestedUsdProvider: UsdProviderId | null;
  countryCode: string | null;
  demoMode: boolean;
};

type PrimaryFundingMethod = 'USD' | 'USDC';

export default function FundingSelector({
  selection,
  onChange,
  amountUsd,
  businessAccountId,
  disabled = false,
}: {
  selection: FundingSelection;
  onChange: (selection: FundingSelection) => void;
  amountUsd: number;
  businessAccountId?: string;
  disabled?: boolean;
}) {
  const [options, setOptions] = useState<FundingOptions | null>(null);
  const [error, setError] = useState<string | null>(null);
  const selectionRef = useRef(selection);
  const onChangeRef = useRef(onChange);

  useEffect(() => {
    selectionRef.current = selection;
  }, [selection]);

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    const controller = new AbortController();
    const params = new URLSearchParams({
      amountUsd: Number.isFinite(amountUsd) && amountUsd > 0 ? String(amountUsd) : '0',
    });
    if (businessAccountId) params.set('businessAccountId', businessAccountId);
    void fetch(`/api/funding/options?${params.toString()}`, { signal: controller.signal, cache: 'no-store' })
      .then(async (response) => {
        if (!response.ok) throw new Error('Funding sources are unavailable');
        const contentType = response.headers.get('content-type') ?? '';
        if (!contentType.includes('application/json')) throw new Error('Funding sources returned an unexpected response');
        return response.json() as Promise<FundingOptions>;
      })
      .then((body) => {
        setError(null);
        setOptions(body);
        const selectionAvailable = isSelectionAvailable(selectionRef.current, body);
        const defaultSelection = defaultTransferSelection(body);
        if (!selectionAvailable && defaultSelection) {
          selectionRef.current = defaultSelection;
          onChangeRef.current(defaultSelection);
          return;
        }
      })
      .catch((fetchError: unknown) => {
        if (controller.signal.aborted) return;
        setError(fetchError instanceof Error ? fetchError.message : 'Funding sources are unavailable');
      });
    return () => controller.abort();
  }, [amountUsd, businessAccountId]);

  if (error) {
    return (
      <Alert variant="destructive">
        <AlertTitle>Payment sources unavailable</AlertTitle>
        <AlertDescription>{error}</AlertDescription>
      </Alert>
    );
  }

  if (!options) {
    return (
      <div className="flex items-center gap-2 rounded-xl bg-[#F6F0ED] p-4 text-sm font-semibold text-[#326273]/65">
        <Loader2 className="size-4 animate-spin" />
        Loading payment sources...
      </div>
    );
  }

  if (!options.featureEnabled) {
    return (
      <Alert>
        <AlertTitle>Bank funding</AlertTitle>
        <AlertDescription>Dual funding is disabled. The existing bank source remains available.</AlertDescription>
      </Alert>
    );
  }

  const fundingOptions = options;
  const primaryMethod = primaryMethodForSelection(selection);
  const selectedAsset = selection.type === 'stablecoin'
    ? options.stablecoinAssets.find((asset) => asset.symbol === selection.asset) ?? null
    : null;
  const bankSource = options.sources.find((source) => source.id === 'BANK_USD');
  const heldSource = options.sources.find((source) => source.id === 'SPLASH_BALANCE');
  const usdcSource = options.sources.find((source) => source.id === 'USDC');
  const canUseBank = Boolean(bankSource?.enabled);
  const canUseUsdcBalance = Boolean(heldSource?.enabled);
  const canUseUsdcDeposit = Boolean(usdcSource?.enabled && options.stablecoinAssets.some((asset) => asset.symbol === 'USDC'));
  const canUseUsdc = canUseUsdcBalance || canUseUsdcDeposit;

  function selectPrimary(method: PrimaryFundingMethod) {
    if (disabled) return;
    const nextSelection = selectionForPrimary(method, fundingOptions);
    if (!nextSelection) return;
    if (sameFundingSelection(selectionRef.current, nextSelection)) return;
    selectionRef.current = nextSelection;
    onChange(nextSelection);
  }

  function changeProvider(provider: UsdProviderId) {
    const nextSelection: FundingSelection = { source: 'BANK_USD', type: 'fiat', provider, feeTier: 'STANDARD' };
    if (sameFundingSelection(selectionRef.current, nextSelection)) return;
    selectionRef.current = nextSelection;
    onChange(nextSelection);
  }

  function selectUsdcBalance() {
    if (!canUseUsdcBalance || disabled) return;
    const nextSelection: FundingSelection = { source: 'SPLASH_BALANCE', type: 'held', feeTier: 'DISCOUNT' };
    if (sameFundingSelection(selectionRef.current, nextSelection)) return;
    selectionRef.current = nextSelection;
    onChange(nextSelection);
  }

  function selectUsdcDeposit() {
    if (!canUseUsdcDeposit || disabled) return;
    const nextSelection = selectionFromSource('USDC', fundingOptions);
    if (!nextSelection) return;
    if (sameFundingSelection(selectionRef.current, nextSelection)) return;
    selectionRef.current = nextSelection;
    onChange(nextSelection);
  }

  function changeRail(rail: StablecoinRail) {
    if (selection.type !== 'stablecoin') return;
    const asset = fundingOptions.stablecoinAssets.find((item) => item.symbol === selection.asset);
    const nextSelection: FundingSelection = {
      ...selection,
      rail,
      sourceChain: rail === 'CCTP' ? asset?.cctpSourceChains[0] : undefined,
    };
    if (sameFundingSelection(selectionRef.current, nextSelection)) return;
    selectionRef.current = nextSelection;
    onChange(nextSelection);
  }

  return (
    <div className="flex flex-col gap-5 rounded-2xl border border-[#326273]/12 bg-white p-4 shadow-[0_16px_40px_rgba(12,62,72,0.08)] md:p-5">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex items-start gap-3">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-[#5C9EAD]/14 text-[#326273]">
            <ShieldCheck className="size-5" aria-hidden="true" />
          </div>
          <div>
            <h3 className="font-bold text-[#0C3E48]">Pay from</h3>
            <p className="mt-1 max-w-md text-xs leading-5 text-[#326273]/65">
              Choose the money you want to use. Details stay one level down so the transfer path stays easy to scan.
            </p>
          </div>
        </div>
        <div className="rounded-xl border border-[#326273]/10 bg-[#F6F0ED] px-3 py-2 text-left sm:text-right">
          <span className="block text-[10px] font-bold uppercase tracking-[0.14em] text-[#326273]/50">Applied fee</span>
          <span className="mt-0.5 block text-xs font-bold text-[#0C3E48]">{selection.feeTier}</span>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2" role="group" aria-label="Transfer funding method">
        <PrimaryFundingButton
          active={primaryMethod === 'USD'}
          disabled={disabled || !canUseBank}
          icon="USD"
          label="USD"
          title="Pay in USD"
          detail="Bank transfer with Stripe or Airwallex"
          meta={bankSource?.unavailableReason ?? 'STANDARD fee'}
          onClick={() => selectPrimary('USD')}
        />
        <PrimaryFundingButton
          active={primaryMethod === 'USDC'}
          disabled={disabled || !canUseUsdc}
          icon="USDC"
          label="USDC"
          title="Pay with USDC"
          detail={canUseUsdcBalance ? `Use ${options.heldBalanceUsdc} USDC balance instantly` : 'Deposit USDC with a QR address'}
          meta={!canUseUsdc ? usdcSource?.unavailableReason ?? 'USDC unavailable' : 'DISCOUNT fee'}
          onClick={() => selectPrimary('USDC')}
        />
      </div>

      <ContextualFlow
        selection={selection}
        options={fundingOptions}
        selectedAsset={selectedAsset}
        disabled={disabled}
        canUseUsdcBalance={canUseUsdcBalance}
        canUseUsdcDeposit={canUseUsdcDeposit}
        onProviderChange={changeProvider}
        onRailChange={changeRail}
        onUsdcBalance={selectUsdcBalance}
        onUsdcDeposit={selectUsdcDeposit}
        onChainChange={(sourceChain) => {
          if (selection.type !== 'stablecoin') return;
          const nextSelection: FundingSelection = { ...selection, sourceChain };
          if (sameFundingSelection(selectionRef.current, nextSelection)) return;
          selectionRef.current = nextSelection;
          onChange(nextSelection);
        }}
      />
    </div>
  );
}

function PrimaryFundingButton({
  active,
  disabled,
  icon,
  label,
  title,
  detail,
  meta,
  onClick,
}: {
  active: boolean;
  disabled: boolean;
  icon: PrimaryFundingMethod;
  label: string;
  title: string;
  detail: string;
  meta: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'flex min-h-32 items-stretch gap-3 rounded-2xl border p-4 text-left transition-[background-color,border-color,box-shadow,transform] duration-150 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-[#5C9EAD]/20 disabled:cursor-not-allowed disabled:opacity-55',
        active
          ? 'border-[#0C3E48] bg-[#0C3E48] text-white shadow-[0_14px_30px_rgba(12,62,72,0.18)]'
          : 'border-[#326273]/14 bg-[#F6F0ED]/45 text-[#0C3E48] shadow-sm hover:-translate-y-0.5 hover:border-[#5C9EAD]/70 hover:bg-[#F8FCFD]',
      )}
    >
      <span className={cn(
        'flex size-10 shrink-0 items-center justify-center rounded-xl',
        active ? 'bg-white/12 text-white' : icon === 'USD' ? 'bg-[#5C9EAD]/14 text-[#326273]' : 'bg-[#E39774]/14 text-[#9F5839]',
      )}
      >
        {icon === 'USD' ? <Landmark className="size-5" aria-hidden="true" /> : <Coins className="size-5" aria-hidden="true" />}
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className={cn('text-[10px] font-bold uppercase tracking-[0.16em]', active ? 'text-white/55' : 'text-[#326273]/45')}>{label}</span>
        <strong className="mt-1 text-base leading-tight">{title}</strong>
        <span className={cn('mt-1 text-xs leading-5', active ? 'text-white/68' : 'text-[#326273]/62')}>{detail}</span>
        <span className={cn('mt-auto pt-3 text-[10px] font-bold uppercase tracking-[0.14em]', active ? 'text-[#bfe6ee]' : 'text-[#326273]/45')}>{meta}</span>
      </span>
      <span className={cn(
        'flex size-6 shrink-0 items-center justify-center rounded-full border',
        active ? 'border-[#5C9EAD] bg-[#5C9EAD] text-white' : 'border-[#326273]/20 text-transparent',
      )}
      >
        <Check className="size-3.5" aria-hidden="true" />
      </span>
    </button>
  );
}

function isSelectionAvailable(selection: FundingSelection, options: FundingOptions) {
  const source = options.sources.find((item) => item.id === selection.source);
  if (!source?.enabled) return false;
  if (selection.type === 'held') return source.type === 'held';
  if (selection.type === 'fiat') {
    return source.type === 'fiat' && options.usdProviders.some((provider) => provider.id === selection.provider);
  }
  return selection.asset === 'USDC'
    && source.type === 'stablecoin'
    && selection.source === 'USDC'
    && options.stablecoinAssets.some((asset) => asset.symbol === 'USDC' && asset.rails.includes(selection.rail));
}

function defaultTransferSelection(options: FundingOptions): FundingSelection | null {
  if (options.sources.some((source) => source.id === 'BANK_USD' && source.enabled)) {
    return selectionFromSource('BANK_USD', options);
  }
  if (options.sources.some((source) => source.id === 'SPLASH_BALANCE' && source.enabled)) {
    return selectionFromSource('SPLASH_BALANCE', options);
  }
  if (options.sources.some((source) => source.id === 'USDC' && source.enabled)) {
    return selectionFromSource('USDC', options);
  }
  return null;
}

function selectionForPrimary(method: PrimaryFundingMethod, options: FundingOptions): FundingSelection | null {
  if (method === 'USD') return selectionFromSource('BANK_USD', options);
  if (options.sources.some((source) => source.id === 'SPLASH_BALANCE' && source.enabled)) {
    return selectionFromSource('SPLASH_BALANCE', options);
  }
  return selectionFromSource('USDC', options);
}

function selectionFromSource(source: FundingSourceId, options: FundingOptions): FundingSelection | null {
  if (source === 'SPLASH_BALANCE') return { source: 'SPLASH_BALANCE', type: 'held', feeTier: 'DISCOUNT' };
  if (source === 'BANK_USD') {
    const provider = options.suggestedUsdProvider ?? options.usdProviders[0]?.id;
    return provider ? { source: 'BANK_USD', type: 'fiat', provider, feeTier: 'STANDARD' } : null;
  }
  const asset = options.stablecoinAssets.find((item) => item.symbol === source);
  if (!asset?.rails[0]) return null;
  const rail = asset.rails[0];
  return {
    source: asset.symbol,
    type: 'stablecoin',
    asset: asset.symbol,
    rail,
    sourceChain: rail === 'CCTP' ? asset.cctpSourceChains[0] : undefined,
    feeTier: 'DISCOUNT',
  };
}

function primaryMethodForSelection(selection: FundingSelection): PrimaryFundingMethod {
  return selection.type === 'fiat' ? 'USD' : 'USDC';
}

function sameFundingSelection(left: FundingSelection, right: FundingSelection) {
  if (left.type !== right.type || left.source !== right.source || left.feeTier !== right.feeTier) return false;
  if (left.type === 'held' && right.type === 'held') return true;
  if (left.type === 'fiat' && right.type === 'fiat') return left.provider === right.provider;
  if (left.type === 'stablecoin' && right.type === 'stablecoin') {
    return left.asset === right.asset && left.rail === right.rail && left.sourceChain === right.sourceChain;
  }
  return false;
}

function ContextualFlow({
  selection,
  options,
  selectedAsset,
  disabled,
  canUseUsdcBalance,
  canUseUsdcDeposit,
  onProviderChange,
  onRailChange,
  onChainChange,
  onUsdcBalance,
  onUsdcDeposit,
}: {
  selection: FundingSelection;
  options: FundingOptions;
  selectedAsset: StablecoinAsset | null;
  disabled: boolean;
  canUseUsdcBalance: boolean;
  canUseUsdcDeposit: boolean;
  onProviderChange: (provider: UsdProviderId) => void;
  onRailChange: (rail: StablecoinRail) => void;
  onChainChange: (sourceChain: CctpSourceChain) => void;
  onUsdcBalance: () => void;
  onUsdcDeposit: () => void;
}) {
  if (selection.type === 'held') {
    return (
      <div className="min-h-36 rounded-2xl border border-[#326273]/10 bg-[#F6F0ED]/45 p-4 transition-[background-color,border-color,box-shadow] duration-150">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex min-w-0 items-start gap-3">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-[#5C9EAD]/12 text-[#326273]">
              <WalletCards className="size-4" aria-hidden="true" />
            </span>
            <div className="min-w-0">
              <h4 className="text-sm font-bold text-[#0C3E48]">Using available USDC balance</h4>
              <p className="mt-1 text-xs leading-5 text-[#326273]/60">
                Splash will debit held native USDC at confirmation. Available balance: {options.heldBalanceUsdc} USDC.
              </p>
            </div>
          </div>
          {canUseUsdcDeposit ? (
            <button
              type="button"
              disabled={disabled}
              onClick={onUsdcDeposit}
              className="inline-flex min-h-10 items-center justify-center rounded-xl border border-[#326273]/14 bg-white px-3 py-2 text-xs font-bold text-[#0C3E48] transition-all hover:border-[#5C9EAD]/70 hover:bg-[#F8FCFD] focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-[#5C9EAD]/18 disabled:cursor-not-allowed disabled:opacity-60"
            >
              Deposit USDC instead
            </button>
          ) : null}
        </div>
      </div>
    );
  }

  if (selection.type === 'fiat') {
    return (
      <div className="min-h-36 rounded-2xl border border-[#326273]/10 bg-[#F6F0ED]/45 p-4 transition-[background-color,border-color,box-shadow] duration-150">
        <div>
          <h4 className="text-sm font-bold text-[#0C3E48]">USD bank provider</h4>
          <p className="mt-1 text-xs leading-5 text-[#326273]/60">
            {options.countryCode === 'MY' ? 'Airwallex is suggested for Malaysia. Both providers remain selectable.' : 'Stripe is suggested for your region. Both providers remain selectable.'}
          </p>
        </div>
        <div className="mt-4 grid gap-2 sm:grid-cols-2">
          {options.usdProviders.map((provider) => {
            const active = selection.provider === provider.id;
            return (
              <button
                key={provider.id}
                type="button"
                disabled={disabled}
                onClick={() => onProviderChange(provider.id)}
                className={cn(
                  'flex min-h-20 items-center gap-3 rounded-xl border p-3 text-left transition-[background-color,border-color,box-shadow] duration-150 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-[#5C9EAD]/18 disabled:cursor-not-allowed disabled:opacity-60',
                  active
                    ? 'border-[#5C9EAD] bg-[#EAF7F8] shadow-[inset_3px_0_0_#5C9EAD,0_10px_22px_rgba(12,62,72,0.08)]'
                    : 'border-[#326273]/12 bg-white hover:border-[#5C9EAD]/70 hover:bg-[#F8FCFD]',
                )}
              >
                <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-[#5C9EAD]/12 text-[#326273]">
                  {provider.id === 'STRIPE' ? <CircleDollarSign className="size-4" aria-hidden="true" /> : <Building2 className="size-4" aria-hidden="true" />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-bold text-[#0C3E48]">{provider.label}</span>
                  <span className="block text-xs text-[#326273]/60">{provider.rails.join(' / ')}</span>
                </span>
                {active ? <Check className="size-4 shrink-0 text-[#326273]" aria-hidden="true" /> : null}
              </button>
            );
          })}
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-36 rounded-2xl border border-[#326273]/10 bg-[#F6F0ED]/45 p-4 transition-[background-color,border-color,box-shadow] duration-150">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h4 className="text-sm font-bold text-[#0C3E48]">USDC deposit</h4>
          <p className="mt-1 text-xs leading-5 text-[#326273]/60">
            Deposit details and QR appear after confirmation. CCTP must mint native USDC on Sui; wrapped assets are rejected.
          </p>
        </div>
        {canUseUsdcBalance ? (
          <button
            type="button"
            disabled={disabled}
            onClick={onUsdcBalance}
            className="inline-flex min-h-10 items-center justify-center rounded-xl border border-[#326273]/14 bg-white px-3 py-2 text-xs font-bold text-[#0C3E48] transition-all hover:border-[#5C9EAD]/70 hover:bg-[#F8FCFD] focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-[#5C9EAD]/18 disabled:cursor-not-allowed disabled:opacity-60"
          >
            Use USDC balance
          </button>
        ) : null}
      </div>

      <div className="mt-4 flex flex-col gap-4">
        {selectedAsset && selectedAsset.rails.length > 1 ? (
          <div className="grid w-full grid-cols-2 gap-2">
            {selectedAsset.rails.map((rail) => (
              <button
                key={rail}
                type="button"
                disabled={disabled}
                onClick={() => onRailChange(rail)}
                className={cn(
                  'min-h-11 rounded-xl border px-4 py-3 text-sm font-bold text-[#0C3E48] transition-[background-color,border-color,box-shadow] duration-150 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-[#5C9EAD]/18 disabled:cursor-not-allowed disabled:opacity-60',
                  selection.rail === rail
                    ? 'border-[#5C9EAD] bg-[#EAF7F8] shadow-[inset_0_-3px_0_#5C9EAD,0_10px_22px_rgba(12,62,72,0.08)]'
                    : 'border-[#326273]/12 bg-white hover:border-[#5C9EAD]/70 hover:bg-[#F8FCFD]',
                )}
              >
                {rail === 'SUI_NATIVE' ? 'Sui native' : 'Circle CCTP'}
              </button>
            ))}
          </div>
        ) : (
          <div className="rounded-xl border border-[#5C9EAD]/25 bg-white p-3 text-sm text-[#326273]">
            <span className="font-bold">USDC</span> uses the Sui native rail for this source.
          </div>
        )}

        {selection.rail === 'CCTP' ? (
          <div className="flex flex-col gap-2">
            <label className="text-xs font-bold uppercase tracking-wide text-[#326273]/55" htmlFor="cctp-source-chain">Source chain</label>
            <Select
              value={selection.sourceChain ?? undefined}
              onValueChange={(value) => onChainChange(value as CctpSourceChain)}
              disabled={disabled}
            >
              <SelectTrigger id="cctp-source-chain" className="w-full bg-white">
                <SelectValue placeholder="Select source chain" />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {selectedAsset?.cctpSourceChains.map((chain) => <SelectItem key={chain} value={chain}>{chain}</SelectItem>)}
                </SelectGroup>
              </SelectContent>
            </Select>
          </div>
        ) : null}

        <div className="rounded-xl border border-[#326273]/10 bg-white p-3 text-xs leading-5 text-[#326273]/65">
          <Banknote className="mr-2 inline size-4 text-[#5C9EAD]" aria-hidden="true" />
          USDC will settle as native USDC before payment_router.
        </div>
      </div>
    </div>
  );
}
