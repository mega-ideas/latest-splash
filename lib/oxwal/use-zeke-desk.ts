'use client';

import { useCallback, useEffect, useState } from 'react';

import type { ZekeDeskSnapshot } from '@/lib/agent/zeke-desk';

/**
 * The desk snapshot (GET /api/oxwal/desk) for the Zeke page and the floating
 * Zeke. `null` until it is read, and `null` again when the server refused or
 * could not be reached: a refusal is "not known", never "nothing waiting".
 */

type Read = { snapshot: ZekeDeskSnapshot | null; state: 'ready' | 'unavailable' };

async function readDesk(signal?: AbortSignal): Promise<Read | null> {
  try {
    const response = await fetch('/api/oxwal/desk', { cache: 'no-store', signal });
    if (!response.ok) return { snapshot: null, state: 'unavailable' };
    return { snapshot: (await response.json()) as ZekeDeskSnapshot, state: 'ready' };
  } catch {
    // Aborted on unmount: nothing to apply.
    if (signal?.aborted) return null;
    return { snapshot: null, state: 'unavailable' };
  }
}

export function useZekeDesk() {
  const [snapshot, setSnapshot] = useState<ZekeDeskSnapshot | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'unavailable'>('loading');

  const apply = useCallback((read: Read | null) => {
    if (!read) return;
    if (read.state === 'unavailable') {
      setSnapshot(null);
    } else {
      setSnapshot(read.snapshot);
    }
    setState(read.state);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void readDesk(controller.signal).then(apply);
    return () => controller.abort();
  }, [apply]);

  const refresh = useCallback(() => readDesk().then(apply), [apply]);

  return { snapshot, state, refresh };
}

/**
 * The Splash wallet's USDC, formatted, or null when it could not be read
 * (no passkey yet, no database, the chain did not answer). Same route the
 * Wallet page reads; the page states a balance only when this returned one.
 */
export function useWalletUsdc(format: (minor: bigint) => string) {
  const [usdc, setUsdc] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    void fetch('/api/stablecoin/wallet', { cache: 'no-store', signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) return;
        const body = (await response.json()) as { usdcMinor?: string };
        if (typeof body.usdcMinor === 'string' && /^\d+$/.test(body.usdcMinor)) setUsdc(format(BigInt(body.usdcMinor)));
      })
      .catch(() => {
        // Unread is shown as nothing, not as zero.
      });
    return () => controller.abort();
  }, [format]);
  return usdc;
}
