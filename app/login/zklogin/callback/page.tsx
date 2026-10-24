'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

import SplashLoading from '@/components/SplashLoading';

/**
 * Where Google returns after a zkLogin sign-in.
 *
 * Google sends the id_token in the URL FRAGMENT, not the query string, so it
 * never reaches the server as part of the request line and never lands in an
 * access log or a Referer header. This page reads it client-side and POSTs it
 * to /api/auth/zklogin, which verifies it independently — the token is not
 * trusted because it arrived here, it is trusted because the server checked
 * its signature against Google's JWKS and recomputed the nonce.
 *
 * The ephemeral key material is read back from sessionStorage and cleared
 * immediately, whatever the outcome. A stale ephemeral key in a tab is a
 * signing key nobody is watching.
 */
export default function ZkLoginCallbackPage() {
  const router = useRouter();
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const fragment = new URLSearchParams(window.location.hash.replace(/^#/, ''));
      const jwt = fragment.get('id_token');
      const oauthError = fragment.get('error');

      // Whatever happens next, the fragment does not stay in history.
      window.history.replaceState(null, '', window.location.pathname);

      const pendingRaw = sessionStorage.getItem('splash.zklogin.pending');
      sessionStorage.removeItem('splash.zklogin.pending');

      if (oauthError) {
        if (!cancelled) setError('Google sign-in was cancelled.');
        return;
      }
      if (!jwt || !pendingRaw) {
        if (!cancelled) setError('This sign-in link is incomplete. Start again from the login page.');
        return;
      }

      let pending: { maxEpoch: number; randomness: string; ephemeralPublicKey: string };
      try {
        pending = JSON.parse(pendingRaw) as typeof pending;
      } catch {
        if (!cancelled) setError('This sign-in could not be completed. Start again from the login page.');
        return;
      }

      try {
        const res = await fetch('/api/auth/zklogin', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jwt,
            provider: 'google',
            ephemeralPublicKey: pending.ephemeralPublicKey,
            maxEpoch: pending.maxEpoch,
            randomness: pending.randomness,
          }),
        });

        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          if (!cancelled) setError(body.error ?? 'Sign-in could not be verified.');
          return;
        }

        // Identity is established. Authority is not — and neither is the
        // business verification that authority depends on.
        //
        // Home is the first screen after every sign-in (v2 D14). This used to
        // go straight to /settings/kyb, because a banner alone is not an
        // onboarding step. The step is on Home now: Account setup stays on the
        // rail, with its progress, until setup is complete, and the read-only
        // banner links to verification.
        router.replace('/dashboard');
      } catch {
        if (!cancelled) setError('Sign-in could not be completed. Check your connection and try again.');
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [router]);

  if (error) {
    return (
      <main className="iso-auth-callback">
        <h1>Sign-in did not complete</h1>
        <p role="alert">{error}</p>
        <a href="/login">Back to sign in</a>
      </main>
    );
  }

  return <SplashLoading label="Verifying your sign-in" />;
}
