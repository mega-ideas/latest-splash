/**
 * A person belongs to ONE business (v2 Phase 3 review, High).
 *
 * The accept path and the add-directly path both checked "does this person
 * already belong to a business?", then inserted, then looked again. Under
 * Postgres READ COMMITTED two transactions that run at the same moment cannot
 * see each other's uncommitted row, so both checks pass and both commit: one
 * person on two businesses, and authority resolution (limit 1, no order) then
 * picks one of them without being told which.
 *
 * Two parts make that impossible, and neither can be shown by racing two
 * transactions on PGlite (it serialises them), so each is tested directly:
 *
 *   1. The DATABASE refuses a second membership row for the same person
 *      (a unique index on memberships(user_id)).
 *   2. Both paths take a per-person lock first (`lockPerson`, SELECT ... FOR NO
 *      KEY UPDATE on the person's row), so the second request waits for the
 *      first to commit and then reads its row.
 *
 * And when the check is stale (the other transaction committed after it read),
 * the path ends in the plain refusal and writes nothing, instead of an error or
 * the wrong sentence. The stale read is simulated by a handle that answers the
 * "which businesses is this person on?" read with nothing.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { eq } from 'drizzle-orm';

import { migratedDb } from './helpers/store-db.mjs';
import * as schema from '../lib/db/schema.ts';
import * as teamAdmin from '../lib/server/team-admin.ts';
import { acceptInvitation, sendInvitation } from '../lib/server/team-invitations.ts';

const T0 = new Date('2026-11-02T09:00:00Z');
const VERIFIED = new Date('2026-10-01T00:00:00Z');
const base = { orgId: 'acme', now: () => T0 };

async function seeded() {
  const { client, db } = await migratedDb();
  const people = [
    ['u-owner', 'owner@acme.test', 'acme', 'admin'],
    ['u-n-owner', 'owner@northwind.test', 'northwind', 'admin'],
    ['u-n-maker', 'maker@northwind.test', 'northwind', 'maker'],
    ['u-free', 'free@example.test', null, null],
  ];
  for (const [id, email, org, role] of people) {
    await db.insert(schema.users).values({ id, email, name: id, emailVerifiedAt: VERIFIED });
    if (org) await db.insert(schema.memberships).values({ id: `m-${id}`, userId: id, orgId: org, role });
  }
  return { client, db };
}

/** A handle whose FIRST "which businesses is this person on?" read finds nothing, as a read taken just before the other transaction committed would. */
function staleMembershipRead(db) {
  let lied = false;
  const wrap = (tx) =>
    new Proxy(tx, {
      get(target, prop) {
        if (prop === 'select') {
          return (fields) => {
            const real = target.select(fields);
            if (!fields || Object.keys(fields).join() !== 'orgId') return real;
            return {
              from(table) {
                if (table !== schema.memberships || lied) return real.from(table);
                lied = true;
                return { where: () => Promise.resolve([]) };
              },
            };
          };
        }
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  return new Proxy(db, {
    get(target, prop) {
      if (prop === 'transaction') return (fn) => target.transaction((tx) => fn(wrap(tx)));
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

test('the database refuses a second membership for the same person, whatever the code checked', async () => {
  const { client, db } = await seeded();
  await assert.rejects(
    db.insert(schema.memberships).values({ id: 'm-second', userId: 'u-n-maker', orgId: 'acme', role: 'viewer' }),
    (error) => /memberships_user_unique|duplicate key/i.test(String(error?.cause?.message ?? error?.message)),
  );
  assert.equal((await db.select().from(schema.memberships).where(eq(schema.memberships.userId, 'u-n-maker'))).length, 1);
  // A different person in the same business is fine.
  await db.insert(schema.memberships).values({ id: 'm-free', userId: 'u-free', orgId: 'acme', role: 'viewer' });
  await client.close();
});

test('accepting an invitation when the earlier read was stale ends in the plain refusal, with the invitation still open and nothing granted', async () => {
  const { client, db } = await seeded();
  const sent = await sendInvitation(db, { ...base, actorUserId: 'u-owner', email: 'maker@northwind.test', role: 'viewer' });
  assert.equal(sent.ok, true, JSON.stringify(sent));
  const accepted = await acceptInvitation(staleMembershipRead(db), { userId: 'u-n-maker', invitationId: sent.invitation.id, now: () => T0 });
  assert.equal(accepted.ok, false);
  assert.equal(accepted.status, 409);
  assert.equal(accepted.code, 'already_on_a_business');
  const mine = await db.select().from(schema.memberships).where(eq(schema.memberships.userId, 'u-n-maker'));
  assert.deepEqual(mine.map((m) => m.orgId), ['northwind'], 'still only on the business they were on');
  const [inv] = await db.select().from(schema.teamInvitations);
  assert.equal(inv.status, 'pending', 'the invitation was not used up by a refused accept');
  await client.close();
});

test('adding directly when the earlier read was stale says the person cannot be added, not that they are already on this team', async () => {
  const { client, db } = await seeded();
  const added = await teamAdmin.addTeamMember(staleMembershipRead(db), { ...base, actorUserId: 'u-owner', email: 'maker@northwind.test', role: 'viewer' });
  assert.equal(added.ok, false);
  assert.equal(added.code, 'cannot_add');
  assert.deepEqual((await db.select().from(schema.memberships).where(eq(schema.memberships.userId, 'u-n-maker'))).map((m) => m.orgId), ['northwind']);
  await client.close();
});

test('both ways in lock the person first: lockPerson exists, runs, and is called before the person’s memberships are read', async () => {
  assert.equal(typeof teamAdmin.lockPerson, 'function', 'team-admin exports lockPerson');
  const { client, db } = await seeded();
  const locked = await db.transaction((tx) => teamAdmin.lockPerson(tx, 'u-free'));
  assert.equal(locked, true, 'an existing person is locked');
  assert.equal(await db.transaction((tx) => teamAdmin.lockPerson(tx, 'nobody')), false, 'nobody to lock reads as false');
  await client.close();

  for (const [path, fn] of [
    ['lib/server/team-invitations.ts', 'export function acceptInvitation'],
    ['lib/server/team-admin.ts', 'export function addTeamMember'],
  ]) {
    const text = readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
    const start = text.indexOf(fn);
    assert.ok(start >= 0, `${path} has ${fn}`);
    const body = text.slice(start, text.indexOf('\n}\n', start));
    const lock = body.indexOf('lockPerson(');
    const read = body.indexOf('.from(memberships)');
    assert.ok(lock >= 0, `${path}: ${fn} takes the per-person lock`);
    assert.ok(lock < read, `${path}: the lock comes before the memberships are read`);
  }
});

test('authority resolution for a person is deterministic: it orders its one membership read', () => {
  const text = readFileSync(new URL('../lib/auth/authority.ts', import.meta.url), 'utf8');
  const fn = text.slice(text.indexOf('export async function resolveAuthorityFromDb'), text.indexOf('export async function resolveAuthorityForSession'));
  assert.match(fn, /\.orderBy\(/, 'the read has an ORDER BY so it never depends on row order');
});
