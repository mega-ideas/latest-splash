'use client';

import { useCallback, useEffect, useState } from 'react';
import { Wallet } from 'lucide-react';

import {
  connectWallet,
  describeSignError,
  discoverWallets,
  isSignCancelled,
  signMessageWithWallet,
  type AcceptedWallet,
} from '@/lib/wallet/sui-signers';

/**
 * Sign in by signing a server challenge with a Sui wallet.
 *
 * Discovery, connection and message signing all go through the same helpers
 * the rest of Splash uses to sign transactions, so a wallet that works here
 * works everywhere else in the product and there is one place to fix when a
 * wallet changes its behaviour.
 */
export default function WalletSignIn({
  remember,
  onSignedIn,
}: {
  remember: boolean;
  onSignedIn: () => void;
}) {
  const [wallets, setWallets] = useState<AcceptedWallet[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [picking, setPicking] = useState(false);

  useEffect(() => {
    let live = true;
    void discoverWallets().then((found) => { if (live) setWallets(found); });
    // Extensions register asynchronously, so look again shortly after mount.
    const t = setTimeout(() => {
      void discoverWallets().then((found) => { if (live) setWallets(found); });
    }, 500);
    return () => { live = false; clearTimeout(t); };
  }, []);

  const signIn = useCallback(
    async (accepted: AcceptedWallet) => {
      setBusy(accepted.label);
      setError('');
      try {
        const account = await connectWallet(accepted);

        const challenge = await fetch('/api/auth/wallet/challenge', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ address: account.address }),
        });
        const challengeBody = (await challenge.json().catch(() => ({}))) as { message?: string; error?: string };
        if (!challenge.ok || !challengeBody.message) {
          throw new Error(challengeBody.error ?? 'Could not start wallet sign-in.');
        }

        const signature = await signMessageWithWallet(accepted, account, challengeBody.message);

        const verify = await fetch('/api/auth/wallet', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ address: account.address, signature, remember }),
        });
        const verifyBody = (await verify.json().catch(() => ({}))) as { error?: string };
        if (!verify.ok) throw new Error(verifyBody.error ?? 'Wallet sign-in failed.');

        onSignedIn();
      } catch (reason) {
        // Closing the wallet popup is a decision, not a failure to report.
        if (!isSignCancelled(reason)) setError(describeSignError(reason));
      } finally {
        setBusy(null);
        setPicking(false);
      }
    },
    [remember, onSignedIn],
  );

  if (wallets.length === 0) {
    return (
      <p className="iso-auth-wallet-empty">
        No Sui wallet detected in this browser.{' '}
        <a href="https://slush.app" target="_blank" rel="noreferrer">Install Slush</a> to sign in with a wallet.
      </p>
    );
  }

  return (
    <div className="iso-auth-wallet">
      {picking && wallets.length > 1 ? (
        <div className="iso-auth-wallet-list">
          {wallets.map((w) => (
            <button key={w.label} type="button" onClick={() => signIn(w)} disabled={Boolean(busy)}>
              {w.icon && <img src={w.icon} alt="" width={18} height={18} />}
              {busy === w.label ? 'Check your wallet…' : w.label}
            </button>
          ))}
        </div>
      ) : (
        <button
          type="button"
          className="iso-auth-wallet-button"
          disabled={Boolean(busy)}
          onClick={() => (wallets.length > 1 ? setPicking(true) : signIn(wallets[0]))}
        >
          <Wallet size={16} aria-hidden />
          {busy ? 'Check your wallet…' : 'Connect wallet'}
        </button>
      )}
      {error && <p className="iso-auth-wallet-error">{error}</p>}
    </div>
  );
}
