import { LAUNCH_SCOPE_CODE, LAUNCH_SCOPE_REASON, parseLaunchScope, type LaunchScope } from '../launch-scope-rules.ts';

export * from '../launch-scope-rules.ts';

/**
 * Which launch this deployment is (lib/launch-scope-rules.ts). Read from
 * process.env on every call, like the sweep switch, so tests can flip it;
 * lib/env.ts has already refused a bad value at boot.
 */
export function launchScope(): LaunchScope {
  return parseLaunchScope(process.env.LAUNCH_SCOPE);
}

export function stablecoinOnly(): boolean {
  return launchScope() === 'stablecoin';
}

/**
 * The one guard every fiat, settlement and treasury route calls, after
 * authentication and before anything is read into state or moved: the 403
 * in the stablecoin scope, otherwise null. A plain Response, so the module
 * loads under `node --test` without Next's runtime.
 */
export function refuseOutsideLaunchScope(): Response | null {
  if (!stablecoinOnly()) return null;
  return new Response(
    JSON.stringify({ error: LAUNCH_SCOPE_REASON, code: LAUNCH_SCOPE_CODE, scope: 'stablecoin' satisfies LaunchScope }),
    { status: 403, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } },
  );
}
