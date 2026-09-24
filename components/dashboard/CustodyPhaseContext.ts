'use client';

import { createContext, useContext } from 'react';

/**
 * Whether the custody phase is on, as app/dashboard/layout.tsx resolved it on
 * the server (`custodyPhaseEnabled()`, handed to DashboardShell in `locks`).
 * Pages under /dashboard are client components and cannot import
 * lib/server/custody-phase.ts (it reads the contract config through node:fs),
 * so the shell passes the answer down here.
 *
 * Defaults to false, the gate's own default: outside the shell, or when the
 * layout could not resolve its locks, a fund-holding option reads as locked.
 * Presentation only; the routes enforce the gate themselves.
 */
export const CustodyPhaseContext = createContext(false);

export function useCustodyPhaseOn(): boolean {
  return useContext(CustodyPhaseContext);
}

/**
 * Whether the operator's sweep switch is on (`sweepAccountEnabled()`, resolved
 * by the same layout). It matters only once the custody phase is on: with it
 * off, the routes refuse SWEEP_ACCOUNT, so the transfer form must not offer
 * it. Defaults to false for the same reason the phase does: without the
 * layout's answer, the fund-holding option reads as locked.
 */
export const SweepSwitchContext = createContext(false);

export function useSweepSwitchOn(): boolean {
  return useContext(SweepSwitchContext);
}
