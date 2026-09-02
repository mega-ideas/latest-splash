/**
 * Network profile — the single source of truth for "which Sui network is
 * this deployment on, what is published there, and which corridors exist".
 *
 * Everything that renders a network fact reads from here: the nav badge and
 * sandbox ribbon, receipt explorer links, money-flow corridor cards, roadmap
 * "live" markers, the settlement timeline. Cutover to mainnet is an env
 * change plus a deploy; no code edit names a network.
 *
 * Client/server split: NEXT_PUBLIC_* values are inlined at build time and must
 * be read as literal `process.env.NEXT_PUBLIC_X` accesses. Server-only names
 * (SUI_NETWORK, SPLASH_*_PACKAGE_ID) are consulted as fallbacks so a server
 * component sees the same answer as the browser. Object IDs for on-chain
 * calls still come from lib/server/contract-config.ts (file override wins);
 * this module only decides what the UI may claim.
 */

export type SuiNetwork = 'testnet' | 'mainnet';
export type DeliveryRail = 'sui-native' | 'cctp' | 'wire';
export type CorridorStatus = 'planned' | 'sandbox' | 'live';
export type CorridorCode = 'PH' | 'ID';

export type NetworkCorridor = {
  code: CorridorCode;
  country: string;
  currency: 'PHP' | 'IDR';
  /** Generic by disclosure policy D5; never a partner's legal name. */
  partnerLabel: string;
  deliveryRail: DeliveryRail;
  /** Only for the CCTP hop (e.g. "base", "arbitrum"). */
  destinationChain?: string;
  status: CorridorStatus;
};

export type PackageIds = {
  core: string | null;
  meter: string | null;
  custody: string | null;
};

export type NetworkProfile = {
  network: SuiNetwork;
  packageIds: PackageIds;
  /** True only on mainnet with a real (non-placeholder) core package id. */
  live: boolean;
  explorerBase: { suivision: string; suiscan: string };
  corridors: NetworkCorridor[];
  badges: {
    /** Short chrome label: "Sui testnet" | "Sui mainnet". */
    network: string;
    /** Sandbox ribbon text, or null when there is nothing to warn about. */
    ribbon: string | null;
    /** "Live on Sui mainnet" only when `live`; otherwise null. */
    live: string | null;
    /** Receipt network line. */
    receiptLine: string;
    /** One-line corridor status for footers and tickers. */
    corridorLine: string;
  };
};

const PLACEHOLDER = /^(?:0x0+|0x[0-9a-f]{0,15}|placeholder|tbd|todo|pending)?$/i;

function cleanId(value: string | undefined): string | null {
  const trimmed = (value ?? '').trim();
  if (!trimmed || PLACEHOLDER.test(trimmed)) return null;
  return trimmed;
}

/**
 * Mainnet if either the public or the server variable says so. The
 * conservative direction for labels and for the payout-safety guards in
 * lib/server/sui-settlement.ts, which must never think they are on testnet
 * when a mainnet key is loaded.
 */
export function resolveNetwork(): SuiNetwork {
  if (process.env.NEXT_PUBLIC_SUI_NETWORK === 'mainnet') return 'mainnet';
  if (process.env.SUI_NETWORK === 'mainnet') return 'mainnet';
  return 'testnet';
}

function resolvePackageIds(): PackageIds {
  return {
    core: cleanId(process.env.NEXT_PUBLIC_SPLASH_CORE_PACKAGE_ID) ?? cleanId(process.env.SPLASH_CORE_PACKAGE_ID),
    meter: cleanId(process.env.NEXT_PUBLIC_SPLASH_METER_PACKAGE_ID) ?? cleanId(process.env.SPLASH_METER_PACKAGE_ID),
    custody: cleanId(process.env.NEXT_PUBLIC_SPLASH_CUSTODY_PACKAGE_ID) ?? cleanId(process.env.SPLASH_CUSTODY_PACKAGE_ID),
  };
}

/* Corridor facts that do not change with the network. Status and delivery
   rail are per-deployment and come from env:
     NEXT_PUBLIC_CORRIDOR_STATUS="PH=sandbox,ID=planned"
     NEXT_PUBLIC_CORRIDOR_RAILS="PH=sui-native,ID=cctp:base"
   Corridors launch staggered: first-ready first. */
const CORRIDOR_BASE: Array<Omit<NetworkCorridor, 'status' | 'deliveryRail' | 'destinationChain'>> = [
  { code: 'PH', country: 'Philippines', currency: 'PHP', partnerLabel: 'Licensed payout partner · PHP' },
  { code: 'ID', country: 'Indonesia', currency: 'IDR', partnerLabel: 'Licensed payout partner · IDR' },
];

function parsePairs(raw: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of (raw ?? '').split(',')) {
    const [key, value] = pair.split('=').map((part) => part.trim());
    if (key && value) out[key.toUpperCase()] = value;
  }
  return out;
}

function resolveCorridors(network: SuiNetwork): NetworkCorridor[] {
  const statuses = parsePairs(process.env.NEXT_PUBLIC_CORRIDOR_STATUS);
  const rails = parsePairs(process.env.NEXT_PUBLIC_CORRIDOR_RAILS);
  return CORRIDOR_BASE.map((corridor) => {
    const rawStatus = statuses[corridor.code];
    // Nothing is live on testnet, whatever the env says.
    const status: CorridorStatus =
      network === 'mainnet' && rawStatus === 'live' ? 'live' : rawStatus === 'planned' ? 'planned' : 'sandbox';
    const [rail, destinationChain] = (rails[corridor.code] ?? 'sui-native').split(':');
    const deliveryRail: DeliveryRail = rail === 'cctp' || rail === 'wire' ? rail : 'sui-native';
    return {
      ...corridor,
      status,
      deliveryRail,
      ...(deliveryRail === 'cctp' && destinationChain ? { destinationChain } : {}),
    };
  });
}

export function explorerBaseFor(network: SuiNetwork) {
  return {
    suivision: network === 'mainnet' ? 'https://suivision.xyz' : `https://${network}.suivision.xyz`,
    suiscan: `https://suiscan.xyz/${network}`,
  };
}

export function getNetworkProfile(): NetworkProfile {
  const network = resolveNetwork();
  const packageIds = resolvePackageIds();
  const live = network === 'mainnet' && packageIds.core !== null;
  const corridors = resolveCorridors(network);
  const liveCorridors = corridors.filter((corridor) => corridor.status === 'live');
  const corridorLine =
    liveCorridors.length > 0
      ? `Live corridors: ${liveCorridors.map((corridor) => corridor.currency).join(' · ')}`
      : `Corridors ${corridors.map((corridor) => corridor.currency).join(' · ')} · staggered launch · no customer funds until MFCA activation`;

  return {
    network,
    packageIds,
    live,
    explorerBase: explorerBaseFor(network),
    corridors,
    badges: {
      network: network === 'mainnet' ? 'Sui mainnet' : 'Sui testnet',
      ribbon: network === 'testnet' ? 'Sandbox — Sui testnet — no customer funds' : null,
      live: live ? 'Live on Sui mainnet' : null,
      receiptLine: network === 'mainnet' ? 'Sui mainnet' : 'Sui · sandbox, no customer funds',
      corridorLine,
    },
  };
}

/** Transaction page on the chosen explorer for the current network. */
export function explorerTxUrl(digest: string, explorer: 'suivision' | 'suiscan' = 'suivision'): string {
  const base = explorerBaseFor(resolveNetwork());
  return explorer === 'suiscan' ? `${base.suiscan}/tx/${digest}` : `${base.suivision}/txblock/${digest}`;
}

export function explorerAccountUrl(address: string): string {
  return `${explorerBaseFor(resolveNetwork()).suivision}/account/${address}`;
}

export function explorerObjectUrl(objectId: string): string {
  return `${explorerBaseFor(resolveNetwork()).suivision}/object/${objectId}`;
}

/** Both explorer links for a digest, in the shape API payloads already use. */
export function explorerLinksFor(digest: string | null) {
  return {
    suiVisionTxUrl: digest ? explorerTxUrl(digest, 'suivision') : null,
    suiScanTxUrl: digest ? explorerTxUrl(digest, 'suiscan') : null,
  };
}

/** Receipt network line: "Sui mainnet" or "Sui · sandbox, no customer funds". */
export function receiptNetworkLine(): string {
  return getNetworkProfile().badges.receiptLine;
}
