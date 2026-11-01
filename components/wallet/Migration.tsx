'use client';

import { useState } from 'react';
import { ArrowRight, Fingerprint } from 'lucide-react';

import { call, errorText, type SigningView } from '@/components/transfer/api';
import SignPanel from '@/components/transfer/SignPanel';
import { Field, PrimaryButton, QuietButton, SelectInput } from '@/components/transfer/ui';
import { shortAddress } from '@/lib/payments/stablecoin-lane';
import { titleAndRole } from '@/lib/team/member-title';
import { describeSignError, signApprovalWithPasskey } from '@/lib/wallet/sui-signers';
import { personsInChargeView, type Member } from '@/lib/wallet-page/members';
import { migrationRows, type Authority, type FundsRow, type MigrationRow } from '@/lib/wallet-page/migration';
import { Card, Loading, Note, useLoad } from './parts';
import { WALLET_LABELS } from './SetupWallet';

type Found = FundsRow & { name: string };
type Migration = { businessWallet: string | null; you: { userId: string; authority: Authority }; members: Found[] };
export type InCharge = { personsInCharge: Array<{ userId: string; name: string; title?: string | null }>; members: Member[] };

/** "CFO" or "CFO, Staff": the title, and the role beside it when the title does not already say it. */
const titleWithRole = (m: Member) => {
  const { title, role } = titleAndRole(m);
  return role ? `${title}, ${role}` : title;
};

const LABELS = { ...WALLET_LABELS, working: 'Moving your USDC', done: 'Your USDC is in the business wallet', doneNote: 'It now shows in the wallet balance.', deadNote: 'Nothing moved. You can start the move again.' };

/**
 * Move to your business wallet (v2 brief 4.1, 5.5). Each member's USDC in
 * their own passkey wallet can be moved into the business wallet, one plain
 * transfer the member signs on their own device. USDC only. An owner moves
 * their own at once; anyone else needs the sign-off of an owner or the
 * person in charge, which that person signs with their own passkey. Nobody
 * signs off their own move.
 */
export default function Migration({ onChanged }: { onChanged: () => void }) {
  const data = useLoad<Migration>('/api/wallet/migration', 'Funds in personal wallets could not be read.');
  const [request, setRequest] = useState<SigningView | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /** A sign-off the server prepared, shown in full before it is signed. */
  const [pending, setPending] = useState<{ id: string; message: string; row: MigrationRow } | null>(null);

  if (data.loading) return <Card id="migration" title="Move to your business wallet"><Loading label="Looking for USDC in personal wallets…" /></Card>;
  if (!data.data) return <Card id="migration" title="Move to your business wallet"><Note>{data.error}</Note></Card>;
  const { you, members } = data.data;
  const viewer = { userId: you.userId, authority: you.authority };
  const rows = migrationRows(members, viewer);
  const names = new Map(members.map((m) => [m.userId, m.name]));
  if (rows.length === 0 && !request && you.authority !== 'owner') return null;

  async function move(row: MigrationRow) {
    setBusy(row.address);
    setError(null);
    setNotice(null);
    const answer = await call<{ request?: SigningView; more?: boolean }>('/api/wallet/migration', { body: {} });
    setBusy(null);
    if (!answer.ok || !answer.body?.request) {
      setError(errorText(answer, 'The move was not started. Nothing was sent.'));
      return;
    }
    if (answer.body.more) setNotice('This wallet holds a lot of coins. Move again after this one to bring the rest.');
    setRequest(answer.body.request);
  }

  /** Prepares the statement and shows it. Nothing is signed until the approver has read it and chosen to sign. */
  async function prepareSignOff(row: MigrationRow) {
    setBusy(row.address);
    setError(null);
    setNotice(null);
    const made = await call<{ signOff?: { id: string; message: string } }>('/api/wallet/migration/sign-offs', { body: { memberUserId: row.userId, fromAddress: row.address } });
    setBusy(null);
    if (!made.ok || !made.body?.signOff) {
      setError(errorText(made, 'The sign-off could not be prepared.'));
      return;
    }
    setPending({ id: made.body.signOff.id, message: made.body.signOff.message, row });
  }

  async function signOff() {
    if (!pending) return;
    setBusy(pending.row.address);
    setError(null);
    try {
      const key = await call<{ passkey?: { publicKey: string; rpId: string } | null }>('/api/stablecoin/wallet');
      const passkey = key.body?.passkey;
      if (!passkey) throw new Error('Your passkey is not set up on this device yet. Set it up in Settings, then sign off.');
      const signature = await signApprovalWithPasskey(passkey, pending.message);
      const done = await call(`/api/wallet/migration/sign-offs/${encodeURIComponent(pending.id)}`, { body: { signature } });
      if (!done.ok) throw new Error(errorText(done, 'The sign-off was not accepted.'));
      setNotice(`Signed off. ${names.get(pending.row.userId) ?? 'They'} can move their USDC now.`);
      setPending(null);
      data.reload();
    } catch (e) {
      setError(describeSignError(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card id="migration" title="Move to your business wallet">
      <div className="space-y-3">
        <p className="text-[13px] leading-5 text-[#326273]">
          USDC that sits in a team member&rsquo;s own Splash passkey wallet can be moved into the business wallet. Each person signs their own move on their own device. Only USDC is moved.
        </p>
        {request ? (
          <SignPanel initial={request} labels={LABELS} onExecuted={() => { setRequest(null); data.reload(); onChanged(); }} onRestart={() => setRequest(null)} />
        ) : rows.length === 0 ? (
          <Note>No USDC is waiting in personal wallets.</Note>
        ) : (
          <ul className="space-y-2">
            {rows.map((r) => (
              <li key={r.address} className="rounded-xl border border-[#326273]/15 bg-white p-3">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-bold text-[#0c3e48]">{r.mine ? 'Your personal wallet' : `${names.get(r.userId) ?? 'A member'}’s personal wallet`}</p>
                    <p className="font-mono text-[13px] tabular-nums text-[#326273]">{r.amount} USDC at {shortAddress(r.address)}</p>
                  </div>
                  {r.action === 'move' ? <PrimaryButton type="button" disabled={busy !== null} onClick={() => void move(r)}><ArrowRight className="h-4 w-4" aria-hidden="true" />{busy === r.address ? 'Preparing…' : 'Move to the business wallet'}</PrimaryButton> : null}
                  {r.action === 'sign_off' ? <QuietButton type="button" disabled={busy !== null} onClick={() => void prepareSignOff(r)}><Fingerprint className="h-4 w-4" aria-hidden="true" />{busy === r.address ? 'Preparing…' : 'Sign off their move'}</QuietButton> : null}
                </div>
                {r.action === 'ask' ? <p className="mt-2 text-[13px] text-[#326273]">{you.authority === 'person_in_charge' ? 'Someone else with the highest authority signs off your move: an owner, or another person in charge.' : 'An owner or the person in charge signs this off first. Ask them to open this page.'}</p> : null}
                {r.action === 'wait' ? <p className="mt-2 text-[13px] text-[#326273]">{names.get(r.userId) ?? 'They'} can move this themselves{members.find((m) => m.address === r.address)?.clearance === 'signed_off' ? ': it is signed off' : ' once it is signed off'}.</p> : null}
                {r.action === 'other_site' ? <p className="mt-2 text-[13px] text-[#326273]">This passkey belongs to another site, so it cannot sign here. Its holder moves it from that site.</p> : null}
              </li>
            ))}
          </ul>
        )}
        {pending ? (
          <div className="space-y-3 rounded-xl border border-[#0d6370]/30 bg-[#f4f8fa] p-4" role="group" aria-label="Sign-off statement">
            <p className="text-sm font-bold text-[#0c3e48]">You are signing this statement</p>
            <pre className="whitespace-pre-wrap break-all rounded-lg bg-white p-3 font-mono text-[13px] leading-5 text-[#0c3e48]">{pending.message}</pre>
            <p className="text-[13px] leading-5 text-[#326273]">This sign-off is for the wallet above, not for an amount: it covers whatever the wallet holds when it is used, until it expires. Check the From and To addresses match what you expect.</p>
            <div className="flex flex-wrap gap-2">
              <PrimaryButton type="button" disabled={busy !== null} onClick={() => void signOff()}><Fingerprint className="h-4 w-4" aria-hidden="true" />{busy === pending.row.address ? 'Waiting for your passkey…' : 'Sign with your passkey'}</PrimaryButton>
              <QuietButton type="button" disabled={busy !== null} onClick={() => setPending(null)}>Cancel</QuietButton>
            </div>
          </div>
        ) : null}
        {notice ? <Note>{notice}</Note> : null}
        {error ? <Note tone="error">{error}</Note> : null}
        {you.authority === 'owner' ? <PersonInCharge /> : null}
      </div>
    </Card>
  );
}

/** An owner appoints or revokes the person in charge: the other person who may sign off a staff member's move. */
/**
 * The person in charge: an owner appoints and takes back. Shown here (Move to your business wallet) and in Settings → Team.
 * Settings already has the team and passes it in (`given`), so the page reads it once and a change refreshes the whole
 * team; here it reads for itself.
 */
export function PersonInCharge({ given, onChanged }: { given?: InCharge; onChanged?: () => void } = {}) {
  const own = useLoad<InCharge>(given ? null : '/api/wallet/persons-in-charge', 'The people in charge could not be loaded.');
  const data = given ? { data: given, loading: false, error: null, reload: () => onChanged?.() } : own;
  const [pick, setPick] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (data.loading) return <Loading label="Loading…" />;
  if (!data.data) return <Note>{data.error}</Note>;
  const view = personsInChargeView(data.data.members, data.data.personsInCharge);

  async function act(userId: string, appoint: boolean) {
    setBusy(true);
    setError(null);
    const answer = appoint
      ? await call('/api/wallet/persons-in-charge', { body: { userId } })
      : await call(`/api/wallet/persons-in-charge?userId=${encodeURIComponent(userId)}`, { method: 'DELETE' });
    setBusy(false);
    if (!answer.ok) setError(errorText(answer, 'That did not work.'));
    else {
      setPick('');
      data.reload();
    }
  }

  return (
    <div className="space-y-2 rounded-xl bg-[#f4f8fa] p-3">
      <h3 className="text-[13px] font-extrabold text-[#0c3e48]">Person in charge</h3>
      <p className="text-[13px] leading-5 text-[#326273]">Someone you trust to sign off a team member&rsquo;s move, next to the owners. They move no money and sign nothing on the wallet.</p>
      {view.inCharge.length > 0 ? (
        <ul className="space-y-1.5">
          {view.inCharge.map((m) => (
            <li key={m.userId} className="flex flex-wrap items-center justify-between gap-2 text-sm text-[#1F4452]">
              <span className="font-semibold">{m.name} <span className="font-normal text-[#326273]">({titleWithRole(m)})</span></span>
              <QuietButton type="button" disabled={busy} onClick={() => void act(m.userId, false)}>Take back</QuietButton>
            </li>
          ))}
        </ul>
      ) : null}
      {view.candidates.length > 0 ? (
        <div className="flex flex-wrap items-end gap-2">
          <Field label="Put someone in charge" htmlFor="pic-pick" className="w-full min-w-0 sm:w-auto sm:flex-1">
            <SelectInput id="pic-pick" value={pick} onChange={(e) => setPick(e.target.value)}>
              <option value="">Choose a team member</option>
              {view.candidates.map((m) => <option key={m.userId} value={m.userId}>{m.name} ({titleWithRole(m)})</option>)}
            </SelectInput>
          </Field>
          <PrimaryButton type="button" disabled={busy || !pick} onClick={() => void act(pick, true)}>Put in charge</PrimaryButton>
        </div>
      ) : view.inCharge.length === 0 ? (
        <Note>No staff or approvers to choose from yet.</Note>
      ) : null}
      {error ? <Note tone="error">{error}</Note> : null}
    </div>
  );
}
