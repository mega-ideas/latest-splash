/**
 * DeepBook venue whitelist helpers (audit S-12).
 *
 * `liquidity_guard::assert_deepbook_liquidity` (splash_custody; the v1 testnet
 * package had it in peg_monitor) measures depth and slippage on a
 * `Pool` object the CALLER supplies. DeepBook pools are permissionlessly
 * creatable, so without a whitelist the guard proves nothing: stand up a pool,
 * seed it with your own liquidity, and every assert passes. `ComplianceConfig`
 * now carries `allowed_deepbook_pools` and the guard aborts with 353 on anything
 * else.
 *
 * These helpers are pure so they can be unit-tested without a chain: parsing the
 * whitelist off a `VecSet<ID>` and comparing it against `DEEPBOOK_POOL_ID` is
 * exactly where an off-by-one-encoding bug would silently disable the check.
 */

/** Canonical Sui object id: lowercase, 0x-prefixed, left-padded to 32 bytes. */
export function normalizeObjectId(entry: unknown): string | null {
  const raw =
    typeof entry === 'string'
      ? entry
      : entry && typeof entry === 'object' && 'bytes' in entry
        ? (entry as { bytes: unknown }).bytes
        : null;
  if (typeof raw !== 'string') return null;

  const trimmed = raw.trim().toLowerCase();
  if (!/^0x[0-9a-f]{1,64}$/.test(trimmed)) return null;
  // Sui prints ids in full 32-byte form but accepts short forms in config. Pad
  // so `0x2` and `0x000…002` compare equal instead of silently missing.
  return `0x${trimmed.slice(2).padStart(64, '0')}`;
}

/**
 * Read `allowed_deepbook_pools` out of a ComplianceConfig JSON blob.
 *
 * Returns `null` when the field is absent — that means the DEPLOYED package
 * predates the whitelist, which is a different fact from "the whitelist is
 * empty". Collapsing the two would make an unenforced package look like a
 * locked-down one.
 */
export function parsePoolWhitelist(fields: Record<string, unknown> | null | undefined): string[] | null {
  if (!fields || fields.allowed_deepbook_pools === undefined) return null;

  const set = fields.allowed_deepbook_pools as unknown;
  const contents = Array.isArray(set)
    ? set
    : set && typeof set === 'object' && Array.isArray((set as { contents?: unknown[] }).contents)
      ? (set as { contents: unknown[] }).contents
      : [];

  return contents.map(normalizeObjectId).filter((id): id is string => id !== null);
}

export type PoolWhitelistVerdict =
  | { allowed: true; enforced: boolean; poolId: string }
  | { allowed: false; enforced: boolean; poolId: string; reason: string };

/**
 * Decide whether the configured venue may be used.
 *
 * `whitelist === null` (package predates the field) is reported as allowed with
 * `enforced: false` rather than blocked: refusing here would take settlement
 * down on the currently deployed package, and the honest signal is "the control
 * is not live yet", which callers surface instead of pretending it is.
 */
export function checkPoolAllowed(poolId: string | null | undefined, whitelist: string[] | null): PoolWhitelistVerdict {
  const normalized = normalizeObjectId(poolId ?? '');
  const shown = (poolId ?? '').trim();

  if (!normalized) {
    return {
      allowed: false,
      enforced: whitelist !== null,
      poolId: shown,
      reason: shown
        ? `DEEPBOOK_POOL_ID is not a valid object id: ${shown}`
        : 'DEEPBOOK_POOL_ID is not configured.',
    };
  }
  if (whitelist === null) return { allowed: true, enforced: false, poolId: normalized };
  if (whitelist.includes(normalized)) return { allowed: true, enforced: true, poolId: normalized };

  return {
    allowed: false,
    enforced: true,
    poolId: normalized,
    reason:
      `DEEPBOOK_POOL_ID ${normalized.slice(0, 12)}… is not on the on-chain whitelist ` +
      `(${whitelist.length} allowed). Run scripts/set-compliance-config.mjs --allow-pool ${normalized} ` +
      `with the ComplianceCap, or point DEEPBOOK_POOL_ID at a venue that is already allowed.`,
  };
}
