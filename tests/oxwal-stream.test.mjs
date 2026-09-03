import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  getOxwalRun,
  oxwalRunResponse,
  resetOxwalRunsForTests,
  startOxwalRun,
  subscribeOxwalRun,
} from '../lib/agent/stream-hub.ts';
import { openOxwalStream, parseSseFrames } from '../lib/oxwal/stream-client.ts';

async function* scripted(events, { failAfter = Infinity } = {}) {
  let index = 0;
  for (const event of events) {
    if (index >= failAfter) throw new Error('model unreachable');
    index += 1;
    await new Promise((resolve) => setTimeout(resolve, 2));
    yield event;
  }
}

const META = { type: 'meta', source: 'local', readTools: [], proposeTools: [] };

function waitForDone(run) {
  return new Promise((resolve) => subscribeOxwalRun(run, Infinity, () => {}, resolve));
}

test('a run stores sequence-numbered events and replays them to late subscribers', async () => {
  resetOxwalRunsForTests();
  const run = startOxwalRun({ orgId: 'org_a', actorId: 'u1', source: scripted([META, { type: 'delta', text: 'hi' }, { type: 'done' }]) });
  assert.equal(run.events[0].event.type, 'run');
  await waitForDone(run);

  const replayed = [];
  subscribeOxwalRun(run, 1, (entry) => replayed.push(entry), () => {});
  assert.deepEqual(replayed.map((entry) => entry.seq), [2, 3]);
  assert.deepEqual(replayed.map((entry) => entry.event.type), ['delta', 'done']);
  assert.equal(getOxwalRun(run.id), run);
  assert.equal(run.done, true);
});

test('a generator failure becomes an error event followed by done, never a hung run', async () => {
  resetOxwalRunsForTests();
  const run = startOxwalRun({ orgId: 'org_a', actorId: 'u1', source: scripted([META, { type: 'delta', text: 'x' }], { failAfter: 1 }) });
  await waitForDone(run);
  const types = run.events.map((entry) => entry.event.type);
  assert.deepEqual(types, ['run', 'meta', 'error', 'done']);
});

test('the SSE response carries ids and resumes from ?after', async () => {
  resetOxwalRunsForTests();
  const run = startOxwalRun({ orgId: 'org_a', actorId: 'u1', source: scripted([META, { type: 'delta', text: 'a' }, { type: 'delta', text: 'b' }, { type: 'done' }]) });
  const full = await oxwalRunResponse(run, -1, { heartbeatMs: 5 }).text();
  assert.match(full, /^id: 0\ndata: \{"type":"run"/);
  assert.match(full, /id: 4\ndata: \{"type":"done"\}/);

  const resumed = await oxwalRunResponse(run, 2, { heartbeatMs: 5 }).text();
  const { frames } = parseSseFrames(resumed);
  assert.deepEqual(frames.map((frame) => frame.id), [3, 4]);
  assert.equal(oxwalRunResponse(run, -1).headers.get('X-Oxwal-Run'), run.id);
});

test('parseSseFrames keeps partial frames and skips heartbeats', () => {
  const { frames, rest } = parseSseFrames(': keep-alive\n\nid: 7\ndata: {"type":"delta","text":"x"}\n\nid: 8\ndata: {"ty');
  assert.deepEqual(frames, [{ id: 7, data: '{"type":"delta","text":"x"}' }]);
  assert.equal(rest, 'id: 8\ndata: {"ty');
});

function sseBody(frames, { dropAfter = Infinity } = {}) {
  const encoder = new TextEncoder();
  let index = 0;
  return new ReadableStream({
    pull(controller) {
      if (index >= frames.length) {
        controller.close();
        return;
      }
      if (index >= dropAfter) {
        controller.error(new Error('socket reset'));
        return;
      }
      const [id, event] = frames[index];
      index += 1;
      controller.enqueue(encoder.encode(`id: ${id}\ndata: ${JSON.stringify(event)}\n\n`));
    },
  });
}

test('the client resumes a dropped stream from the last sequence and de-duplicates', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, method: init?.method ?? 'GET' });
    if (url === '/api/oxwal') {
      return new Response(
        sseBody([[0, { type: 'run', runId: 'run_1' }], [1, META], [2, { type: 'delta', text: 'Hel' }], [3, { type: 'delta', text: 'lo' }]], { dropAfter: 3 }),
        { status: 200, headers: { 'X-Oxwal-Run': 'run_1' } },
      );
    }
    if (calls.length === 2) throw new TypeError('network down');
    assert.equal(url, '/api/oxwal/run_1?after=2');
    return new Response(sseBody([[2, { type: 'delta', text: 'Hel' }], [3, { type: 'delta', text: 'lo' }], [4, { type: 'done' }]]), { status: 200 });
  };

  const events = [];
  const statuses = [];
  const result = await openOxwalStream({
    message: 'hi',
    history: [],
    fetchImpl,
    sleep: async () => {},
    jitter: () => 0.5,
    delaysMs: [10, 20, 40],
    onEvent: (event) => events.push(event),
    onStatus: (status) => statuses.push(status.phase),
  });

  assert.equal(result, 'done');
  assert.deepEqual(events.map((event) => (event.type === 'delta' ? event.text : event.type)), ['meta', 'Hel', 'lo', 'done']);
  assert.deepEqual(statuses, ['connecting', 'streaming', 'reconnecting', 'reconnecting', 'streaming', 'done']);
  assert.equal(calls.length, 3);
});

test('the client reports why a start was refused and retries only safe statuses', async () => {
  const forbidden = await openOxwalStream({
    message: 'hi',
    history: [],
    fetchImpl: async () => new Response('{}', { status: 403 }),
    sleep: async () => {},
    onEvent: () => {},
    onStatus: (status) => {
      if (status.phase === 'failed') {
        assert.equal(status.reason, 'origin');
        assert.equal(status.started, false);
      }
    },
  });
  assert.equal(forbidden, 'failed');

  let attempts = 0;
  const statuses = [];
  const recovered = await openOxwalStream({
    message: 'hi',
    history: [],
    fetchImpl: async () => {
      attempts += 1;
      if (attempts === 1) return new Response('busy', { status: 503 });
      return new Response(sseBody([[0, { type: 'run', runId: 'run_2' }], [1, { type: 'done' }]]), { status: 200 });
    },
    sleep: async () => {},
    startDelaysMs: [5, 5],
    onEvent: () => {},
    onStatus: (status) => statuses.push(status.phase),
  });
  assert.equal(recovered, 'done');
  assert.equal(attempts, 2);
  assert.ok(statuses.includes('reconnecting'));
});
