'use client';

import { fromBase64 } from '@mysten/sui/utils';

/**
 * The signers the stablecoin lane accepts, in the browser.
 *
 *   Splash wallet   the business's own passkey. Its Sui address comes from
 *                   the passkey's public key (SIP-9); only the device that
 *                   holds the passkey can sign. Splash stores the public half.
 *   Slush           a Sui wallet, found through the Wallet Standard.
 *   MetaMask        only with the Sui Snap (desktop): MetaMask does not speak
 *                   Sui by itself. The Snap registers itself as a Wallet
 *                   Standard wallet named "Sui MetaMask Snap".
 *
 * Phantom ended Sui support on 24 September 2026 and is not offered. Every
 * signer here SIGNS only — Splash dry-runs the signed bytes and submits them
 * itself (lib/server/stablecoin-send.ts), so a wallet never broadcasts a
 * transfer Splash has not checked.
 */

export const SUI_MAINNET_CHAIN = 'sui:mainnet' as const;

export type WalletKind = 'SLUSH' | 'METAMASK_SUI_SNAP';

// The Wallet Standard shapes this module touches, kept structural so the
// Mysten and Kuna Labs packages can differ in version without a type fight.
type StdAccount = { address: string; chains: readonly string[] };
type StdWallet = {
  name: string;
  icon: string;
  chains: readonly string[];
  accounts: readonly StdAccount[];
  features: Record<string, unknown>;
};
type ConnectFeature = { connect(input?: { silent?: boolean }): Promise<{ accounts: readonly StdAccount[] }> };
type SignTransactionFeature = {
  signTransaction(input: {
    transaction: { toJSON(): Promise<string> };
    account: StdAccount;
    chain: string;
  }): Promise<{ bytes: string; signature: string }>;
};

export interface AcceptedWallet {
  kind: WalletKind;
  label: string;
  icon: string;
  wallet: StdWallet;
}

function kindOf(wallet: StdWallet): WalletKind | null {
  if (wallet.name === 'Sui MetaMask Snap') return 'METAMASK_SUI_SNAP';
  if (/slush/i.test(wallet.name)) return 'SLUSH';
  return null;
}

let snapRegistered = false;

/** The accepted wallets present in this browser. */
export async function discoverWallets(): Promise<AcceptedWallet[]> {
  if (typeof window === 'undefined') return [];
  if (!snapRegistered) {
    snapRegistered = true;
    try {
      const { registerSuiSnapWallet } = await import('@kunalabs-io/sui-snap-wallet');
      registerSuiSnapWallet();
    } catch {
      // No MetaMask, or the Snap adapter could not load: Slush still works.
    }
  }
  const { getWallets } = await import('@wallet-standard/app');
  return (getWallets().get() as unknown as StdWallet[])
    .map((wallet) => ({ wallet, kind: kindOf(wallet) }))
    .filter((w): w is { wallet: StdWallet; kind: WalletKind } =>
      w.kind !== null
      && 'standard:connect' in w.wallet.features
      && 'sui:signTransaction' in w.wallet.features)
    .map(({ wallet, kind }) => ({
      kind,
      wallet,
      icon: wallet.icon,
      label: kind === 'SLUSH' ? 'Slush' : 'MetaMask (Sui Snap)',
    }));
}

/** Connect and pick the account that can sign on Sui mainnet. */
export async function connectWallet(accepted: AcceptedWallet): Promise<StdAccount> {
  const connect = accepted.wallet.features['standard:connect'] as ConnectFeature;
  const { accounts } = await connect.connect();
  const account = accounts.find((a) => a.chains.includes(SUI_MAINNET_CHAIN)) ?? accounts[0];
  if (!account) throw new Error(`${accepted.label} did not share an account.`);
  return account;
}

async function transactionJson(transactionBytesB64: string): Promise<string> {
  const { Transaction } = await import('@mysten/sui/transactions');
  return Transaction.from(fromBase64(transactionBytesB64)).toJSON();
}

/** Sign (not send) the exact bytes Splash built. */
export async function signWithWallet(
  accepted: AcceptedWallet,
  account: StdAccount,
  transactionBytesB64: string,
): Promise<{ bytes: string; signature: string }> {
  const json = await transactionJson(transactionBytesB64);
  const feature = accepted.wallet.features['sui:signTransaction'] as SignTransactionFeature;
  return feature.signTransaction({ transaction: { toJSON: async () => json }, account, chain: SUI_MAINNET_CHAIN });
}

// ─── The Splash wallet: the business's own passkey ──────────────────────────

async function passkeyKeypair(passkey: { publicKey: string; rpId: string }) {
  const { BrowserPasskeyProvider, PasskeyKeypair } = await import('@mysten/sui/keypairs/passkey');
  const provider = new BrowserPasskeyProvider('Splash', {
    rp: { name: 'Splash', id: passkey.rpId },
    authenticatorSelection: {
      authenticatorAttachment: 'platform',
      // A biometric or PIN for every signature: an unlocked laptop is not enough.
      userVerification: 'required',
      residentKey: 'required',
    },
  });
  return new PasskeyKeypair(fromBase64(passkey.publicKey), provider);
}

/** Sign a transfer with the Splash wallet's passkey. */
export async function signWithPasskey(
  passkey: { publicKey: string; rpId: string },
  transactionBytesB64: string,
): Promise<{ bytes: string; signature: string }> {
  const keypair = await passkeyKeypair(passkey);
  return keypair.signTransaction(fromBase64(transactionBytesB64));
}

/** Confirm an approval: the passkey signs the text the server asked for. */
export async function signApprovalWithPasskey(
  passkey: { publicKey: string; rpId: string },
  message: string,
): Promise<string> {
  const keypair = await passkeyKeypair(passkey);
  const { signature } = await keypair.signPersonalMessage(new TextEncoder().encode(message));
  return signature;
}

/** A person cancelling a wallet or passkey prompt is not an error worth alarming them with. */
export function describeSignError(error: unknown): string {
  const name = (error as { name?: string })?.name;
  const message = error instanceof Error ? error.message : String(error);
  if (name === 'NotAllowedError' || /reject|denied|cancel/i.test(message)) return 'Cancelled — nothing was signed.';
  return message;
}
