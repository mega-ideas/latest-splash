'use client';

import { useEffect, useState } from 'react';

import { call } from '@/components/transfer/api';
import type { Manager } from '@/lib/team/view';

export type TeamAccess = { role: string | null; manager: Manager; financeLead: boolean; addFunds: boolean; withdraw: boolean };

/**
 * What the signed-in person may do with Add funds and Withdraw, and whether
 * they manage the team, read from the server (GET /api/team/me). `null` until
 * the answer arrives, and if it never does: a page that asks offers nothing
 * while it is null, so a slow or failed read can only hide a button, never
 * show one. The routes behind each action check the same rule again.
 */
export function useTeamAccess(): TeamAccess | null {
  const [access, setAccess] = useState<TeamAccess | null>(null);
  useEffect(() => {
    let live = true;
    void call<TeamAccess>('/api/team/me').then((answer) => {
      if (live && answer.ok && answer.body) setAccess(answer.body);
    });
    return () => {
      live = false;
    };
  }, []);
  return access;
}
