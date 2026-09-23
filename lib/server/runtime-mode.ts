export function isProductionRuntime(env: NodeJS.ProcessEnv = process.env) {
  return env.NODE_ENV === 'production';
}

export function isDemoRuntime(env: NodeJS.ProcessEnv = process.env) {
  return !isProductionRuntime(env)
    || env.USE_MOCK_APIS === 'true'
    || env.NEXT_PUBLIC_DEMO_MODE === 'true';
}

/**
 * Whether stand-in crypto (mock Seal) may be used instead of a real threshold
 * committee.
 *
 * This used to test NODE_ENV alone, which meant a deployment running with
 * USE_MOCK_APIS=true / NEXT_PUBLIC_DEMO_MODE=true under NODE_ENV=production
 * demanded a live Seal committee and refused every payment with
 * "Seal is read-only: No Seal key servers configured" — the vendor keys are
 * already optional under those same flags in lib/env.ts (see `vendorsLive`),
 * so requiring a Seal committee was inconsistent with the posture the flags
 * declare.
 *
 * It now delegates to isDemoRuntime, so exactly one predicate decides whether
 * this deployment is a demo. The flags are the record of that decision: a
 * deployment that sets neither still gets real crypto and still fails closed.
 */
export function canUseDemoCrypto(env: NodeJS.ProcessEnv = process.env) {
  return isDemoRuntime(env);
}
