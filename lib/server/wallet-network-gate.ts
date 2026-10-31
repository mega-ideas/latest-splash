/**
 * Business wallets on mainnet are switched on in code, not by a checklist
 * line alone (review B4: fail closed in production).
 *
 * A passkey multisig has never signed on any network with real
 * authenticators here: the hardware 2-of-3 check owed from Phase 0
 * (docs/v2/phase2-business-wallet.md, runbook) is a human step. On testnet
 * one approver runs it (Sky, decided 25 Oct) with three of his own
 * authenticators, one per owner login of a testnet business. Until it has
 * passed, and someone has recorded where its evidence is, no wallet request
 * is built on mainnet:
 *
 *   WALLET_MAINNET_ENABLED=true      the switch, off by default;
 *   WALLET_HARDWARE_CHECK_REF        where the evidence is recorded, a path
 *                                    and anchor in docs/ such as
 *                                    docs/mainnet-checks-2026-10.md#wallet-2-of-3.
 *
 * lib/env.ts refuses to boot production with the switch on and no
 * reference. Off mainnet the gate is open: testnet is where the check runs.
 */
export const HARDWARE_CHECK_REF = /^docs\/[A-Za-z0-9._/-]+\.md#[A-Za-z0-9_-]+$/;

export function walletNetworkGate(env: NodeJS.ProcessEnv = process.env): { ok: true } | { ok: false; reason: string } {
  if ((env.SUI_NETWORK ?? '').trim() !== 'mainnet') return { ok: true };
  if ((env.WALLET_MAINNET_ENABLED ?? '').trim() !== 'true') {
    return { ok: false, reason: 'business wallets are not switched on yet: the signing check with real passkeys has not been recorded' };
  }
  if (!HARDWARE_CHECK_REF.test((env.WALLET_HARDWARE_CHECK_REF ?? '').trim())) {
    return { ok: false, reason: 'business wallets are switched on, but no record of the signing check with real passkeys is named (WALLET_HARDWARE_CHECK_REF)' };
  }
  return { ok: true };
}
