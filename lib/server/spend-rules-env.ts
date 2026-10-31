/**
 * splash_spend's ids from the environment (v2 §4.2): the package, whose
 * functions spending-rule transactions call and whose `SPLASH_SPEND` type an
 * allowance is bound to, and the `PolicyRegistry` shared at its publish,
 * under which each business's policy id is derived. Both or nothing: without
 * them no spending-rule transaction is built or understood.
 */
const ID = /^0x[0-9a-fA-F]{64}$/;

export function spendIdsFromEnv(env: NodeJS.ProcessEnv = process.env): { ok: true; spendPackageId: string; policyRegistryId: string } | { ok: false; reason: string } {
  const spendPackageId = (env.SPLASH_SPEND_PACKAGE_ID ?? '').trim();
  const policyRegistryId = (env.SPLASH_SPEND_POLICY_REGISTRY_ID ?? '').trim();
  const missing = [
    ['SPLASH_SPEND_PACKAGE_ID', spendPackageId],
    ['SPLASH_SPEND_POLICY_REGISTRY_ID', policyRegistryId],
  ]
    .filter(([, v]) => !ID.test(v))
    .map(([k]) => k);
  if (missing.length) return { ok: false, reason: `spending rules need ${missing.join(' and ')} (0x + 64 hex each)` };
  return { ok: true, spendPackageId, policyRegistryId };
}
