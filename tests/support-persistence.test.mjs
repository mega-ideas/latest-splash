import assert from 'node:assert/strict';
import test from 'node:test';

import { coldStart, migratedDb, attachDb } from './helpers/store-db.mjs';

/**
 * Support tickets, out of `support.ts`'s `globalThis` map.
 *
 * A ticket is a customer telling us something is wrong with their money — a
 * batch stuck past its SLA, a receipt they need for an audit — and the staff
 * replies are our answer. In a `Map`, a ticket raised on one serverless
 * instance was unknown to the instance the staff console happened to reach,
 * and a cold start lost every ticket and every reply.
 *
 * WS2 scoped the store by org: customer calls take the session's org first,
 * staff reach across tenants through `*ForStaff`. That scoping has to hold in
 * Postgres too, not only in the fallback map.
 */

async function withDb(run) {
  const { client, db } = await migratedDb();
  const undo = attachDb(db);
  try {
    await run({ client, db });
  } finally {
    undo();
    await client.close();
  }
}

const COMPLAINT = {
  type: 'complaint',
  subject: 'Batch payout still pending after SLA',
  message: 'Our Philippines supplier batch has not moved for 20 minutes.',
  email: 'ops@acme.example',
};

test('a cold start keeps an org\'s ticket and every reply on it', async () => {
  await withDb(async ({ client }) => {
    const store = await import('../lib/server/support.ts');
    const ticket = await store.createSupportTicket('acme', COMPLAINT);
    assert.equal(ticket.orgId, 'acme');
    assert.equal(ticket.priority, 'HIGH', 'a complaint is raised as high priority');

    await store.updateSupportTicket('acme', ticket.id, {
      status: 'OPEN',
      actor: 'ops@acme.example',
      actorType: 'customer',
      replyMessage: 'Still nothing on our side.',
    });
    await store.updateSupportTicketForStaff(ticket.id, {
      actor: 'support@splash.example',
      replyMessage: 'The PH rail is degraded; your batch is next in the queue.',
      assignedTo: 'support@splash.example',
    });

    const fresh = await coldStart('lib/server/support.ts');
    const read = await fresh.readSupportTicket('acme', ticket.id);
    assert.ok(read, 'the ticket is still there after a cold start');
    assert.equal(read.subject, COMPLAINT.subject);
    assert.equal(read.email, COMPLAINT.email);
    assert.equal(read.status, 'REPLIED', 'a staff reply with no explicit status marks it replied');
    assert.equal(read.assignedTo, 'support@splash.example');
    assert.deepEqual(
      read.replies.map((r) => [r.actorType, r.actor, r.message]),
      [
        ['customer', 'ops@acme.example', 'Still nothing on our side.'],
        ['staff', 'support@splash.example', 'The PH rail is degraded; your batch is next in the queue.'],
      ],
      'both replies, oldest first',
    );
    assert.deepEqual((await fresh.listSupportTickets('acme')).map((t) => t.id), [ticket.id]);
    assert.ok((await fresh.listSupportTicketsForStaff()).some((t) => t.id === ticket.id));
    assert.equal((await fresh.readSupportTicketForStaff(ticket.id))?.replies.length, 2);

    const { rows } = await client.query(`SELECT org_id FROM support_tickets WHERE id = $1`, [ticket.id]);
    assert.deepEqual(rows, [{ org_id: 'acme' }], 'the row records its owner');
  });
});

test('org B still cannot list, read or reply to org A\'s ticket once it lives in Postgres', async () => {
  await withDb(async ({ client }) => {
    const store = await import('../lib/server/support.ts');
    const ticket = await store.createSupportTicket('acme', COMPLAINT);
    await store.createSupportTicket('northwind', { type: 'other', subject: 'Receipt', message: 'Where is it?' });

    const fresh = await coldStart('lib/server/support.ts');
    assert.equal(await fresh.readSupportTicket('northwind', ticket.id), null, 'a foreign id reads as missing');
    const listed = await fresh.listSupportTickets('northwind');
    assert.equal(listed.length, 1, 'org B sees its own ticket and nothing else — no demo seed in Postgres');
    assert.ok(listed.every((t) => t.orgId === 'northwind'));
    assert.equal(
      await fresh.updateSupportTicket('northwind', ticket.id, {
        actor: 'b@northwind.example',
        actorType: 'customer',
        replyMessage: 'mine now',
        status: 'CLOSED',
      }),
      null,
      'a foreign id cannot be replied to or closed',
    );
    const { rows } = await client.query(`SELECT count(*)::int AS n FROM support_ticket_replies WHERE ticket_id = $1`, [ticket.id]);
    assert.equal(rows[0].n, 0, 'and nothing was written');
    assert.equal((await fresh.readSupportTicket('acme', ticket.id))?.status, 'OPEN', 'the status did not move either');
    assert.deepEqual(await fresh.listSupportTickets(''), [], 'an empty org lists nothing');
    assert.equal(await fresh.readSupportTicket('', ticket.id), null);
  });
});

test('two replies at the same moment both land', async () => {
  await withDb(async () => {
    const store = await import('../lib/server/support.ts');
    const ticket = await store.createSupportTicket('acme', COMPLAINT);
    await Promise.all([
      store.updateSupportTicket('acme', ticket.id, { actor: 'a@acme.example', actorType: 'customer', replyMessage: 'first' }),
      store.updateSupportTicketForStaff(ticket.id, { actor: 'support@splash.example', replyMessage: 'second' }),
    ]);
    const fresh = await coldStart('lib/server/support.ts');
    const read = await fresh.readSupportTicket('acme', ticket.id);
    assert.deepEqual(read?.replies.map((r) => r.message).sort(), ['first', 'second'], 'neither reply overwrote the other');
  });
});

test('a ticket must belong to a workspace that exists', async () => {
  await withDb(async () => {
    const store = await import('../lib/server/support.ts');
    await assert.rejects(async () => store.createSupportTicket('ghost-org', COMPLAINT), 'the foreign key refuses an unknown org');
    await assert.rejects(async () => store.createSupportTicket('', COMPLAINT), /belongs to a workspace/);
  });
});
