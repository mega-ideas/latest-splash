/**
 * What a wallet transaction does, in a plain sentence per command, for the
 * signing screen (v2 brief 4.1, 5.5). The commands are decoded on the
 * signer's own device from the exact bytes (lib/wallet/review-on-device.ts);
 * this only words them. A command the page does not know is left out, never
 * shown as code: the transaction code and the refusal in the reader are what
 * protect the signer, not this list.
 */
import { formatUsdc } from '../fees/copy.ts';

type Action = { type: string } & Record<string, unknown>;

const short = (address: unknown): string => {
  const a = String(address ?? '');
  return a.length > 14 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
};

const usdc = (minor: unknown): string => {
  try {
    return `${formatUsdc(BigInt(String(minor)))} USDC`;
  } catch {
    return 'an amount';
  }
};

export function plainActions(actions: Action[]): string[] {
  const lines: string[] = [];
  for (const a of actions) {
    switch (a.type) {
      case 'nominate_wallet':
        lines.push('Name the new business wallet on your business account.');
        break;
      case 'register_wallet': {
        const members = Array.isArray(a.members) ? a.members.length : 0;
        lines.push(`Create your business wallet: ${a.threshold} of ${members} owners sign every payment.`);
        break;
      }
      case 'rotate_wallet': {
        const members = Array.isArray(a.members) ? a.members.length : 0;
        lines.push(`Change who signs for the business wallet: ${a.threshold} of ${members} owners will sign.`);
        break;
      }
      case 'confirm_wallet_rotation':
        lines.push('Confirm the new set of signers for the business wallet.');
        break;
      case 'cancel_wallet_rotation':
        lines.push('Withdraw the change of signers that is waiting.');
        break;
      case 'add_owner':
        lines.push(`Make ${short(a.address)} an owner of the business account.`);
        break;
      case 'remove_owner':
        lines.push(`Remove ${short(a.address)} as an owner of the business account.`);
        break;
      case 'set_recovery_party':
        lines.push(`Set ${short(a.address)} as the recovery contact.`);
        break;
      case 'merge_coins':
        lines.push(`Combine ${a.coins} USDC coins into one.`);
        break;
      case 'send_funds':
        lines.push(a.amountMinor ? `Send ${usdc(a.amountMinor)} to ${short(a.recipient)}.` : `Send the USDC to ${short(a.recipient)}.`);
        break;
      case 'withdraw':
        lines.push(`Take ${usdc(a.amountMinor)} out of the wallet balance.`);
        break;
      case 'create_spend_policy':
      case 'add_spender':
      case 'remove_spender':
      case 'verify_recipient':
      case 'remove_recipient':
      case 'verify_beneficiary':
      case 'remove_beneficiary':
      case 'set_limits':
      case 'set_running_window':
      case 'propose_allowance':
      case 'accept_allowance':
      case 'revoke_allowance': {
        const line = 'Change your spending rules.';
        if (!lines.includes(line)) lines.push(line);
        break;
      }
      default:
        break;
    }
  }
  return lines;
}
