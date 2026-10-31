/**
 * Operating controls on Settings (v2 brief 5.9). The server lets only an owner
 * or a finance admin move the limits and switches (PUT /api/settings answers
 * 403 `requires_admin` to anyone else), so the page shows everyone else the
 * values without the means to edit them. Pure and client-safe.
 */
export const canEditControls = (role: string | null | undefined): boolean => role === 'OWNER' || role === 'FINANCE_ADMIN';

/** Settings shows two approval thresholds; this says which is which. */
export const CONTROLS_SCOPE_NOTE =
  'These limits, in US dollars, apply to transfers and approvals made in Splash. The spending policy above, in USDC, is set on the chain by your owners and applies to payments from your business wallet. The two are separate.';
