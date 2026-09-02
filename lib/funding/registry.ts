export type PaymentMethod = 'HELD_BALANCE' | 'BANK_USD' | 'STABLECOIN';
export type UsdProviderId = 'STRIPE' | 'AIRWALLEX';
export type StablecoinAssetSymbol = 'USDC' | 'USDSUI' | 'USDT';
export type StablecoinRail = 'SUI_NATIVE' | 'CCTP';
export type CctpSourceChain = 'ETHEREUM' | 'SOLANA' | 'BASE' | 'ARBITRUM';
export type FundingFeeTier = 'STANDARD' | 'DISCOUNT';
export type NormalizeRoute = 'passthrough' | 'dex:usdsui->usdc' | 'dex:usdt->usdc';
export type KytPolicy = 'standard-or-enhanced';
export type FundingSourceId = 'SPLASH_BALANCE' | 'BANK_USD' | StablecoinAssetSymbol;
export type FundingSourceKind = 'held' | 'fiat' | 'stablecoin';

export type UsdProvider = {
  id: UsdProviderId;
  label: string;
  enabled: boolean;
  rails: Array<'ACH' | 'WIRE' | 'FPX'>;
};

export type StablecoinAsset = {
  symbol: StablecoinAssetSymbol;
  label: string;
  coinType: string;
  decimals: number;
  rails: StablecoinRail[];
  cctpSourceChains: CctpSourceChain[];
  normalizeRoute: NormalizeRoute;
  kytPolicy: KytPolicy;
  enabled: boolean;
};

export type FundingSourceOption = {
  id: FundingSourceId;
  type: FundingSourceKind;
  label: string;
  description: string;
  feeTier: FundingFeeTier;
  instant?: boolean;
  enabled: boolean;
  unavailableReason?: string;
  providerIds?: UsdProviderId[];
  rails?: StablecoinRail[];
  balanceMicro?: number;
};

export type FundingRegistry = {
  featureEnabled: boolean;
  usdProviders: UsdProvider[];
  stablecoinAssets: StablecoinAsset[];
};

export type HeldFundingSelection = {
  source: 'SPLASH_BALANCE';
  type: 'held';
  feeTier: 'DISCOUNT';
};

export type FiatFundingSelection = {
  source: 'BANK_USD';
  type: 'fiat';
  provider: UsdProviderId;
  feeTier: 'STANDARD';
};

export type StablecoinFundingSelection = {
  source: StablecoinAssetSymbol;
  type: 'stablecoin';
  asset: StablecoinAssetSymbol;
  rail: StablecoinRail;
  sourceChain?: CctpSourceChain;
  feeTier: 'DISCOUNT';
};

export type FundingSelection = HeldFundingSelection | FiatFundingSelection | StablecoinFundingSelection;

export class FundingRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FundingRegistryError';
  }
}

function envFlag(env: NodeJS.ProcessEnv, key: string, defaultValue: boolean) {
  const value = env[key];
  if (value === undefined || value === '') return defaultValue;
  return value.toLowerCase() === 'true';
}

function enabledCctpChains(env: NodeJS.ProcessEnv): CctpSourceChain[] {
  const definitions: Array<[CctpSourceChain, string]> = [
    ['ETHEREUM', 'FUNDING_CCTP_ETHEREUM_ENABLED'],
    ['SOLANA', 'FUNDING_CCTP_SOLANA_ENABLED'],
    ['BASE', 'FUNDING_CCTP_BASE_ENABLED'],
    ['ARBITRUM', 'FUNDING_CCTP_ARBITRUM_ENABLED'],
  ];

  return definitions.filter(([, key]) => envFlag(env, key, true)).map(([chain]) => chain);
}

export function getFundingRegistry(env: NodeJS.ProcessEnv = process.env): FundingRegistry {
  const demoMode = env.NODE_ENV !== 'production' || env.USE_MOCK_APIS === 'true' || env.NEXT_PUBLIC_DEMO_MODE === 'true';
  const configuredUsdcType = env.USDC_TYPE && env.USDC_TYPE !== '0x2::sui::SUI' ? env.USDC_TYPE : '';
  const usdcType = configuredUsdcType || (demoMode ? 'demo::usdc::USDC' : '');
  const usdsuiType = env.USDSUI_TYPE || (demoMode ? 'demo::usdsui::USDSUI' : '');
  const cctpEnabled = envFlag(env, 'FUNDING_RAIL_CCTP_ENABLED', true);
  const suiNativeEnabled = envFlag(env, 'FUNDING_RAIL_SUI_NATIVE_ENABLED', true);
  const cctpSourceChains = cctpEnabled ? enabledCctpChains(env) : [];

  const usdcRails: StablecoinRail[] = [];
  if (suiNativeEnabled) usdcRails.push('SUI_NATIVE');
  if (cctpEnabled && cctpSourceChains.length > 0) usdcRails.push('CCTP');

  const suiOnlyRails: StablecoinRail[] = suiNativeEnabled ? ['SUI_NATIVE'] : [];

  return {
    featureEnabled: envFlag(env, 'FEATURE_DUAL_FUNDING', true),
    usdProviders: [
      {
        id: 'STRIPE',
        label: 'Stripe',
        enabled: envFlag(env, 'FUNDING_PROVIDER_STRIPE_ENABLED', true),
        rails: ['ACH', 'WIRE'],
      },
      {
        id: 'AIRWALLEX',
        label: 'Airwallex',
        enabled: envFlag(env, 'FUNDING_PROVIDER_AIRWALLEX_ENABLED', true),
        rails: ['WIRE', 'ACH', 'FPX'],
      },
    ],
    stablecoinAssets: [
      {
        symbol: 'USDC',
        label: 'USDC',
        coinType: usdcType,
        decimals: 6,
        rails: usdcRails,
        cctpSourceChains,
        normalizeRoute: 'passthrough',
        kytPolicy: 'standard-or-enhanced',
        enabled: envFlag(env, 'FUNDING_ASSET_USDC_ENABLED', true) && usdcRails.length > 0 && Boolean(usdcType),
      },
      {
        symbol: 'USDSUI',
        label: 'USDsui',
        coinType: usdsuiType,
        decimals: 6,
        rails: suiOnlyRails,
        cctpSourceChains: [],
        normalizeRoute: 'dex:usdsui->usdc',
        kytPolicy: 'standard-or-enhanced',
        enabled: envFlag(env, 'FUNDING_ASSET_USDSUI_ENABLED', true) && suiOnlyRails.length > 0 && Boolean(usdsuiType),
      },
      {
        symbol: 'USDT',
        label: 'USDT',
        coinType: env.USDT_TYPE ?? '',
        decimals: 6,
        rails: usdcRails,
        cctpSourceChains,
        normalizeRoute: 'dex:usdt->usdc',
        kytPolicy: 'standard-or-enhanced',
        enabled: envFlag(env, 'FUNDING_ASSET_USDT_ENABLED', false) && usdcRails.length > 0 && Boolean(env.USDT_TYPE),
      },
    ],
  };
}

export function getEnabledFundingOptions(env: NodeJS.ProcessEnv = process.env): FundingRegistry {
  const registry = getFundingRegistry(env);
  return {
    featureEnabled: registry.featureEnabled,
    usdProviders: registry.usdProviders.filter((provider) => provider.enabled),
    stablecoinAssets: registry.stablecoinAssets.filter((asset) => asset.enabled),
  };
}

export function fundingMethodForSelection(selection: FundingSelection): PaymentMethod {
  if (selection.type === 'held') return 'HELD_BALANCE';
  if (selection.type === 'fiat') return 'BANK_USD';
  return 'STABLECOIN';
}

export function labelForFundingSource(source: FundingSourceId) {
  if (source === 'SPLASH_BALANCE') return 'Splash balance';
  if (source === 'BANK_USD') return 'Bank USD';
  if (source === 'USDSUI') return 'USDsui';
  return source;
}

export function describeFundingSelection(selection: FundingSelection) {
  if (selection.type === 'held') return 'Splash balance';
  if (selection.type === 'fiat') return `Bank USD via ${selection.provider}`;
  return `${selection.asset} via ${selection.rail}${selection.sourceChain ? ` / ${selection.sourceChain}` : ''}`;
}

export function bankFundingSelection(provider: UsdProviderId): FiatFundingSelection {
  return { source: 'BANK_USD', type: 'fiat', provider, feeTier: 'STANDARD' };
}

export function heldFundingSelection(): HeldFundingSelection {
  return { source: 'SPLASH_BALANCE', type: 'held', feeTier: 'DISCOUNT' };
}

export function stablecoinFundingSelection(
  asset: StablecoinAsset,
  rail: StablecoinRail = asset.rails[0],
): StablecoinFundingSelection {
  return {
    source: asset.symbol,
    type: 'stablecoin',
    asset: asset.symbol,
    rail,
    sourceChain: rail === 'CCTP' ? asset.cctpSourceChains[0] : undefined,
    feeTier: 'DISCOUNT',
  };
}

export function buildFundingSources(input: {
  registry: FundingRegistry;
  heldBalanceMicro: number;
  amountDueMicro: number;
}): FundingSourceOption[] {
  const { registry, heldBalanceMicro, amountDueMicro } = input;
  const balanceIsEnough = amountDueMicro > 0 && heldBalanceMicro >= amountDueMicro;
  const bankEnabled = registry.usdProviders.length > 0;
  return [
    {
      id: 'SPLASH_BALANCE',
      type: 'held',
      label: 'Splash balance',
      description: 'Use held native USDC balance with no deposit step.',
      feeTier: 'DISCOUNT',
      instant: true,
      enabled: balanceIsEnough,
      balanceMicro: heldBalanceMicro,
      unavailableReason: balanceIsEnough ? undefined : 'Insufficient held balance',
    },
    {
      id: 'BANK_USD',
      type: 'fiat',
      label: 'Bank USD',
      description: 'Fund from a bank rail with Stripe or Airwallex.',
      feeTier: 'STANDARD',
      enabled: bankEnabled,
      providerIds: registry.usdProviders.map((provider) => provider.id),
      unavailableReason: bankEnabled ? undefined : 'No USD provider is enabled',
    },
    ...registry.stablecoinAssets.map((asset) => ({
      id: asset.symbol,
      type: 'stablecoin' as const,
      label: asset.label,
      description: asset.symbol === 'USDC'
        ? 'Deposit USDC; CCTP mints native USDC on Sui when selected.'
        : `Deposit ${asset.label}; Splash normalizes it to native USDC.`,
      feeTier: 'DISCOUNT' as const,
      enabled: true,
      rails: asset.rails,
    })),
  ];
}

export function selectionForSource(
  source: FundingSourceId,
  registry: FundingRegistry,
  suggestedProvider: UsdProviderId | null,
): FundingSelection | null {
  if (source === 'SPLASH_BALANCE') return heldFundingSelection();
  if (source === 'BANK_USD') {
    const provider = suggestedProvider ?? registry.usdProviders[0]?.id;
    return provider ? bankFundingSelection(provider) : null;
  }
  const asset = registry.stablecoinAssets.find((item) => item.symbol === source);
  return asset ? stablecoinFundingSelection(asset) : null;
}

export function resolveFundingSelection(
  selection: FundingSelection,
  env: NodeJS.ProcessEnv = process.env,
): { selection: FundingSelection; provider?: UsdProvider; asset?: StablecoinAsset } {
  const registry = getFundingRegistry(env);
  if (!registry.featureEnabled) throw new FundingRegistryError('Dual funding is disabled');

  if (selection.type === 'held') {
    if (selection.source !== 'SPLASH_BALANCE') throw new FundingRegistryError('Held funding must use the Splash balance source');
    if (selection.feeTier !== 'DISCOUNT') throw new FundingRegistryError('Held balance funding must use the DISCOUNT fee tier');
    return { selection };
  }

  if (selection.type === 'fiat') {
    if (selection.source !== 'BANK_USD') throw new FundingRegistryError('Fiat funding must use the Bank USD source');
    const provider = registry.usdProviders.find((item) => item.id === selection.provider);
    if (!provider?.enabled) throw new FundingRegistryError(`USD provider ${selection.provider} is disabled`);
    if (selection.feeTier !== 'STANDARD') throw new FundingRegistryError('Bank USD funding must use the STANDARD fee tier');
    return { selection, provider };
  }

  if (selection.source !== selection.asset) {
    throw new FundingRegistryError('Stablecoin source must match the selected asset');
  }

  const asset = registry.stablecoinAssets.find((item) => item.symbol === selection.asset);
  if (!asset?.enabled) throw new FundingRegistryError(`Stablecoin asset ${selection.asset} is disabled`);
  if (!asset.rails.includes(selection.rail)) {
    throw new FundingRegistryError(`${selection.rail} is not enabled for ${selection.asset}`);
  }
  if (selection.feeTier !== 'DISCOUNT') {
    throw new FundingRegistryError('Stablecoin funding must use the DISCOUNT fee tier');
  }

  if (selection.rail === 'CCTP') {
    if (selection.asset !== 'USDC') throw new FundingRegistryError('CCTP intake only accepts canonical USDC');
    if (!selection.sourceChain || !asset.cctpSourceChains.includes(selection.sourceChain)) {
      throw new FundingRegistryError('An enabled CCTP source chain is required');
    }
  } else if (selection.sourceChain) {
    throw new FundingRegistryError('Source chain is only valid for CCTP funding');
  }

  return { selection, asset };
}

export function suggestedUsdProvider(countryCode: string | null | undefined, registry = getEnabledFundingOptions()) {
  const preferred: UsdProviderId = countryCode?.toUpperCase() === 'MY' ? 'AIRWALLEX' : 'STRIPE';
  return registry.usdProviders.find((provider) => provider.id === preferred)?.id
    ?? registry.usdProviders[0]?.id
    ?? null;
}
