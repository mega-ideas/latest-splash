'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { AlertTriangle, RotateCcw } from 'lucide-react';

/**
 * When a page fails, say so.
 *
 * ─── Why this file exists ───────────────────────────────────────────────────
 *
 * There was an `app/loading.tsx` and no error boundary anywhere in the tree. So
 * a server component that threw — the dashboard layout reading KYB state, for
 * instance, when the database is unreachable — left the loading screen on
 * screen. "Preparing your desk", with a ripple animation, indefinitely.
 *
 * That is worse than an error page in a specific way: a spinner is a PROMISE
 * that something is still happening. A customer watching one waits, then
 * reloads, then waits again, and never learns that nothing is coming. Support
 * hears "it's slow" for a database outage.
 *
 * It also cost real diagnostic time on this project: a flaky local Postgres
 * shim was mistaken for a client-side hydration failure, precisely because a
 * failed data read and a slow one looked identical from the browser.
 *
 * ─── What it deliberately does not say ──────────────────────────────────────
 *
 * Not the error message. `error.message` on a server exception can carry a
 * query, a connection string, or a row — this boundary renders for customers,
 * and a stack trace in front of one is an information leak dressed as
 * helpfulness. The digest is shown instead: it is the id that matches this
 * exact failure in the server logs, which is the thing support actually needs.
 */
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // The full error goes to the server console, where it belongs.
    console.error('[app] render failed', error);
  }, [error]);

  return (
    <div className="mx-auto flex min-h-[70vh] w-full max-w-xl flex-col items-center justify-center gap-4 px-6 text-center">
      <div className="grid h-12 w-12 place-items-center rounded-full bg-[#E39774]/15 ring-1 ring-[#E39774]/40">
        <AlertTriangle className="h-6 w-6 text-[#9A4A2D]" />
      </div>

      <h1 className="text-2xl font-bold tracking-tight text-[#0c3e48]">
        This screen could not load
      </h1>

      <p className="max-w-md text-sm font-medium leading-6 text-[#326273]/70">
        Something on our side failed while putting this page together. Nothing you were doing was
        submitted or changed — no payment has moved.
      </p>

      <div className="mt-2 flex flex-wrap items-center justify-center gap-2">
        <button
          type="button"
          onClick={reset}
          className="inline-flex items-center gap-2 rounded-lg bg-[#1F4452] px-4 py-2.5 text-sm font-bold text-white transition hover:bg-[#326273] focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-[#5C9EAD]/30"
        >
          <RotateCcw className="h-4 w-4" />
          Try again
        </button>
        <Link
          href="/dashboard"
          className="rounded-lg border border-[#326273]/20 px-4 py-2.5 text-sm font-bold text-[#326273] transition hover:border-[#5C9EAD]"
        >
          Back to the desk
        </Link>
      </div>

      {/* The id that matches this failure in the server logs. Not the message:
          a server exception can carry a query or a row, and this renders for
          customers. */}
      {error.digest && (
        <p className="mt-4 font-mono text-[11px] uppercase tracking-[0.14em] text-[#326273]/45">
          Reference {error.digest}
        </p>
      )}
    </div>
  );
}
