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
 * This used to test NODE_ENV alone. A deployment running with
 * USE_MOCK_APIS=true / NEXT_PUBLIC_DEMO_MODE=true under NODE_ENV=production
 * therefore demanded a live Seal committee and refused every payment at the
 * final step with "Seal is read-only: No Seal key servers configured" — after
 * the deposit was confirmed and the funds converted, which is the worst place
 * to fail.
 *
 * The vendor keys are already optional under those same flags, so requiring a
 * Seal committee was inconsistent with the posture the flags declare. This now
 * delegates to isDemoRuntime, so exactly one predicate decides whether a
 * deployment is a demo.
 *
 * The invariant that matters is unchanged: a deployment that sets neither flag
 * still gets real crypto and still fails closed.
 */
export function canUseDemoCrypto(env: NodeJS.ProcessEnv = process.env) {
  return isDemoRuntime(env);
}
