/**
 * "Move to your business wallet" (v2 brief 4.1 and 5.5), as the page needs it.
 * Pure, no I/O: the facts come from GET /api/wallet/migration.
 *
 * Who sees what: an owner and the person in charge see every member's USDC
 * that could move, because they sign off a staff member's move. Anyone else
 * sees their own only. Who may move what is decided on the server
 * (lib/server/wallet-authority.ts, `migrationClearance`); this only words it,
 * and never offers a move the server would refuse.
 */
import { formatUsdc } from '../fees/copy.ts';

export type Authority = 'owner' | 'person_in_charge' | null;
export type Viewer = { userId: string; authority: Authority };

export type FoundFunds = { userId: string; address: string; usdcMinor: string; canMove: boolean; needsSignOff: boolean };
export type Clearance = 'not_needed' | 'signed_off' | 'needs_sign_off';
export type FundsRow = FoundFunds & { clearance: Clearance };

/** What the viewer can do about a row. */
export type RowAction =
  /** Move it now: the viewer's own passkey wallet, cleared. */
  | 'move'
  /** Someone else's, needing the highest authority's sign-off, which the viewer can give. */
  | 'sign_off'
  /** The viewer's own, needing a sign-off they cannot give themselves. */
  | 'ask'
  /** Someone else's, already signed off: they move it themselves. */
  | 'wait'
  /** A passkey that cannot sign here: its holder moves it from the site it belongs to. */
  | 'other_site';

/** Owners and the person in charge see all; anyone else only the funds of their own passkey wallets. */
export function scopeMigrationMembers<T extends { userId: string }>(found: T[], viewer: Viewer): T[] {
  if (viewer.authority !== null) return found;
  return found.filter((f) => f.userId === viewer.userId);
}

export type MigrationRow = {
  userId: string;
  address: string;
  amount: string;
  usdcMinor: string;
  mine: boolean;
  action: RowAction;
};

export function migrationRows(found: FundsRow[], viewer: Viewer): MigrationRow[] {
  const rows: MigrationRow[] = [];
  for (const f of found) {
    if (BigInt(f.usdcMinor) <= 0n) continue;
    const mine = f.userId === viewer.userId;
    let action: RowAction;
    if (!f.canMove) action = 'other_site';
    else if (f.clearance === 'not_needed' || (f.clearance === 'signed_off' && mine)) action = mine ? 'move' : 'wait';
    else if (mine) action = 'ask';
    else if (f.clearance === 'signed_off') action = 'wait';
    else action = viewer.authority !== null ? 'sign_off' : 'wait';
    rows.push({ userId: f.userId, address: f.address, amount: formatUsdc(BigInt(f.usdcMinor)), usdcMinor: f.usdcMinor, mine, action });
  }
  return rows;
}
