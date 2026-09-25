'use client';

import { useMemo, useState } from 'react';
import { AlertTriangle, KeyRound, Loader2, ShieldCheck, UserRoundPlus, UserRoundX } from 'lucide-react';
import { toast } from 'sonner';

// From the pure roles module, never from `lib/server/memberships` — that one
// reaches `lib/db/client` and would pull `pg` into the browser bundle.
import { MEMBERSHIP_ROLES, ROLE_MEANING, canApprove, type AccountRow, type MembershipRole } from '@/lib/membership-roles';

/**
 * Grant and revoke workspace memberships.
 *
 * Phase 3 removed every implicit grant, which was right, and left the only
 * route to access being a SQL client. This is that operation with a face on
 * it — and the face matters: the enum names do not say which role can move
 * money, so this screen does.
 */

type Props = {
  initialAccounts: AccountRow[];
  organizations: Array<{ id: string; name: string }>;
};

function roleClass(role: MembershipRole) {
  // Only two of the four can release a payment. They look different.
  if (canApprove(role)) return 'border-[#E39774]/45 bg-[#E39774]/12 text-[#9a4a2d]';
  if (role === 'maker') return 'border-[#5C9EAD]/30 bg-[#5C9EAD]/10 text-[#326273]';
  return 'border-[#326273]/15 bg-white text-[#326273]/90';
}

export default function AdminMemberships({ initialAccounts, organizations }: Props) {
  const [accounts, setAccounts] = useState(initialAccounts);
  const [email, setEmail] = useState('');
  const [orgId, setOrgId] = useState(organizations[0]?.id ?? '');
  // No preselected role. A grant form that opens on a value is a grant waiting
  // to be made by someone who did not read the list.
  const [role, setRole] = useState<MembershipRole | ''>('');
  const [busy, setBusy] = useState(false);
  const [revoking, setRevoking] = useState('');

  const withoutMembership = useMemo(() => accounts.filter((a) => !a.membership), [accounts]);
  const approvers = useMemo(
    () => accounts.filter((a) => a.membership && canApprove(a.membership.role)),
    [accounts],
  );

  async function refresh() {
    const res = await fetch('/api/admin/memberships', { cache: 'no-store' });
    if (!res.ok) return;
    const body = (await res.json()) as { accounts: AccountRow[] };
    setAccounts(body.accounts);
  }

  async function grant() {
    if (!email.trim() || !orgId || !role) return;
    setBusy(true);
    try {
      const res = await fetch('/api/admin/memberships', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim(), orgId, role }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        toast.error(body.error ?? 'The membership could not be granted.');
        return;
      }
      toast.success(`${email.trim()} is now ${role} in ${orgId}.`);
      setEmail('');
      setRole('');
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  async function revoke(target: string) {
    setRevoking(target);
    try {
      const res = await fetch('/api/admin/memberships', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: target }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        toast.error(body.error ?? 'The membership could not be revoked.');
        return;
      }
      toast.success(`${target} no longer has access.`);
      await refresh();
    } finally {
      setRevoking('');
    }
  }

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <header>
        <h1 className="text-2xl font-black tracking-[-0.02em] text-[#1f4350]">Workspace access</h1>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-[#326273]/90">
          An account that signs up has no access. It can log in, see an empty workspace, and do nothing else until a
          membership is granted here. Authority is read from these rows on every request, so a change takes effect on
          the member&apos;s next action — there is no session to wait out.
        </p>
      </header>

      {/* Grant */}
      <section className="rounded-2xl border border-[#326273]/12 bg-white p-6">
        <h2 className="flex items-center gap-2 text-sm font-black uppercase tracking-[0.14em] text-[#326273]/90">
          <UserRoundPlus className="h-4 w-4" />
          Grant access
        </h2>

        <div className="mt-5 grid gap-4 md:grid-cols-3">
          <label className="block">
            <span className="text-xs font-bold uppercase tracking-[0.12em] text-[#326273]/90">Account email</span>
            <input
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="person@company.com"
              className="mt-2 w-full rounded-lg border border-[#326273]/70 px-3 py-2.5 text-sm text-[#1f4350] outline-none focus:border-[#5C9EAD]"
            />
          </label>

          <label className="block">
            <span className="text-xs font-bold uppercase tracking-[0.12em] text-[#326273]/90">Organisation</span>
            <select
              value={orgId}
              onChange={(event) => setOrgId(event.target.value)}
              className="mt-2 w-full rounded-lg border border-[#326273]/70 px-3 py-2.5 text-sm text-[#1f4350] outline-none focus:border-[#5C9EAD]"
            >
              {organizations.length === 0 ? <option value="">No organisations yet</option> : null}
              {organizations.map((org) => (
                <option key={org.id} value={org.id}>
                  {org.name === org.id ? org.id : `${org.name} (${org.id})`}
                </option>
              ))}
            </select>
          </label>

          <label className="block">
            <span className="text-xs font-bold uppercase tracking-[0.12em] text-[#326273]/90">Role</span>
            <select
              value={role}
              onChange={(event) => setRole(event.target.value as MembershipRole | '')}
              className="mt-2 w-full rounded-lg border border-[#326273]/70 px-3 py-2.5 text-sm text-[#1f4350] outline-none focus:border-[#5C9EAD]"
            >
              <option value="">Choose a role…</option>
              {MEMBERSHIP_ROLES.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </label>
        </div>

        {/* What the chosen role actually permits, before the button is pressed.
            "checker" is the most dangerous option and the least alarming word. */}
        {role ? (
          <p
            className={`mt-4 flex items-start gap-2 rounded-lg border px-3.5 py-3 text-sm ${
              canApprove(role)
                ? 'border-[#E39774]/45 bg-[#E39774]/10 text-[#9a4a2d]'
                : 'border-[#326273]/15 bg-[#326273]/[0.03] text-[#326273]/90'
            }`}
          >
            {canApprove(role) ? (
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            ) : (
              <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" />
            )}
            <span>{ROLE_MEANING[role]}</span>
          </p>
        ) : null}

        <button
          type="button"
          onClick={() => void grant()}
          disabled={busy || !email.trim() || !orgId || !role}
          className="mt-5 inline-flex items-center gap-2 rounded-lg bg-[#1f4350] px-5 py-2.5 text-sm font-bold text-white disabled:opacity-45"
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          {busy ? 'Granting…' : 'Grant membership'}
        </button>
      </section>

      {/* Awaiting access — the reason an operator is on this page */}
      {withoutMembership.length > 0 ? (
        <section className="rounded-2xl border border-[#326273]/12 bg-white p-6">
          <h2 className="text-sm font-black uppercase tracking-[0.14em] text-[#326273]/90">
            Awaiting access · {withoutMembership.length}
          </h2>
          <p className="mt-2 text-sm text-[#326273]/90">
            Signed up, cannot act. Granting is a deliberate step, so these stay here until someone takes it.
          </p>
          <ul className="mt-4 divide-y divide-[#326273]/10">
            {withoutMembership.map((account) => (
              <li key={account.userId} className="flex flex-wrap items-center gap-3 py-3">
                <span className="font-semibold text-[#1f4350]">{account.email}</span>
                {!account.hasPassword ? (
                  <span className="inline-flex items-center gap-1 rounded-full border border-[#326273]/15 px-2 py-0.5 text-[12px] font-bold text-[#326273]/90">
                    <KeyRound className="h-3 w-3" /> no password
                  </span>
                ) : null}
                <button
                  type="button"
                  onClick={() => setEmail(account.email)}
                  className="ml-auto rounded-lg border border-[#326273]/20 px-3 py-1.5 text-xs font-bold text-[#326273]"
                >
                  Use this address
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {/* Everyone, with the approvers called out */}
      <section className="rounded-2xl border border-[#326273]/12 bg-white p-6">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h2 className="text-sm font-black uppercase tracking-[0.14em] text-[#326273]/90">
            All accounts · {accounts.length}
          </h2>
          <p className="text-sm text-[#326273]/90">
            {approvers.length} can release a payment.
          </p>
        </div>

        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[720px] border-collapse text-sm">
            <thead>
              <tr className="border-b border-[#326273]/12 text-left text-[12px] uppercase tracking-[0.12em] text-[#326273]/90">
                <th scope="col" className="py-2.5 pr-4 font-bold">Account</th>
                <th scope="col" className="py-2.5 pr-4 font-bold">Organisation</th>
                <th scope="col" className="py-2.5 pr-4 font-bold">Role</th>
                <th scope="col" className="py-2.5 pr-4 font-bold">Granted by</th>
                <th scope="col" className="py-2.5 font-bold" />
              </tr>
            </thead>
            <tbody>
              {accounts.map((account) => (
                <tr key={account.userId} className="border-b border-[#326273]/8">
                  <td className="py-3 pr-4">
                    <span className="font-semibold text-[#1f4350]">{account.email}</span>
                  </td>
                  <td className="py-3 pr-4 text-[#326273]/90">{account.membership?.orgId ?? '—'}</td>
                  <td className="py-3 pr-4">
                    {account.membership ? (
                      <span className={`inline-flex rounded-full border px-2.5 py-0.5 text-[12px] font-bold ${roleClass(account.membership.role)}`}>
                        {account.membership.role}
                      </span>
                    ) : (
                      <span className="text-[#326273]/90">no access</span>
                    )}
                  </td>
                  <td className="py-3 pr-4 text-[13px] text-[#326273]/90">
                    {account.membership?.grantedBy ?? (account.membership ? 'not recorded' : '—')}
                  </td>
                  <td className="py-3 text-right">
                    {account.membership ? (
                      <button
                        type="button"
                        onClick={() => void revoke(account.email)}
                        disabled={revoking === account.email}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-[#326273]/20 px-3 py-1.5 text-xs font-bold text-[#326273] disabled:opacity-45"
                      >
                        {revoking === account.email ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : (
                          <UserRoundX className="h-3 w-3" />
                        )}
                        Revoke
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
