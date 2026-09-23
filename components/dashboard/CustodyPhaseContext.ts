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
