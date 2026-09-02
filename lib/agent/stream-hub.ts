import type { OxwalAgentEvent } from './oxwal';

/**
 * Resumable 0xWal runs.
 *
 * A chat turn is a server-side *run*: the agent generator is pumped once,
 * every event is stored with a sequence number, and any number of SSE
 * responses can attach — the first from the POST that started the run, later
 * ones from GET /api/oxwal/[runId]?after=<seq> when the browser lost the
 * connection mid-answer. The run keeps going while nobody is listening, so a
 * flaky link never produces a half-finished proposal or a duplicate one.
 *
 * Memory only, by design: runs live for a few minutes, carry no secrets the
 * proposal store does not already hold, and are scoped to the org that
 * started them.
 */

export type OxwalRunEvent =
  | OxwalAgentEvent
  | { type: 'run'; runId: string }
  | { type: 'error'; message: string };

export type StoredRunEvent = { seq: number; event: OxwalRunEvent };

type Listener = (entry: StoredRunEvent) => void;

export type OxwalRun = {
  id: string;
  orgId: string;
  actorId: string;
  createdAt: number;
  done: boolean;
  events: StoredRunEvent[];
  listeners: Set<Listener>;
  closers: Set<() => void>;
};

export const RUN_TTL_MS = 10 * 60_000;
export const MAX_RUNS = 200;
const HEARTBEAT_MS = 15_000;

declare global {
  var __oxwalRuns: Map<string, OxwalRun> | undefined;
}

function registry(): Map<string, OxwalRun> {
  if (!globalThis.__oxwalRuns) globalThis.__oxwalRuns = new Map();
  return globalThis.__oxwalRuns;
}

function newRunId() {
  const random = Math.random().toString(36).slice(2, 10);
  return `run_${Date.now().toString(36)}${random}`;
}

/** Proposal payloads carry bigint amounts; JSON needs them as strings. */
export function stringifyRunEvent(value: unknown): string {
  return JSON.stringify(value, (_key, item) => (typeof item === 'bigint' ? item.toString() : item));
}

function evict(now: number) {
  const runs = registry();
  for (const [id, run] of runs) {
    if (run.done && now - run.createdAt > RUN_TTL_MS) runs.delete(id);
  }
  if (runs.size > MAX_RUNS) {
    const oldest = [...runs.values()].sort((a, b) => a.createdAt - b.createdAt);
    for (const run of oldest.slice(0, runs.size - MAX_RUNS)) {
      if (run.done) runs.delete(run.id);
    }
  }
}

function push(run: OxwalRun, event: OxwalRunEvent) {
  const entry: StoredRunEvent = { seq: run.events.length, event };
  run.events.push(entry);
  for (const listener of run.listeners) listener(entry);
}

function finish(run: OxwalRun) {
  if (run.done) return;
  run.done = true;
  for (const close of run.closers) close();
  run.listeners.clear();
  run.closers.clear();
}

export function startOxwalRun(input: {
  orgId: string;
  actorId: string;
  source: AsyncIterable<OxwalAgentEvent>;
  onEvent?: (event: OxwalAgentEvent) => void;
  id?: string;
  now?: number;
}): OxwalRun {
  const now = input.now ?? Date.now();
  evict(now);
  const run: OxwalRun = {
    id: input.id ?? newRunId(),
    orgId: input.orgId,
    actorId: input.actorId,
    createdAt: now,
    done: false,
    events: [],
    listeners: new Set(),
    closers: new Set(),
  };
  registry().set(run.id, run);
  push(run, { type: 'run', runId: run.id });

  void (async () => {
    let sawDone = false;
    try {
      for await (const event of input.source) {
        input.onEvent?.(event);
        push(run, event);
        if (event.type === 'done') {
          sawDone = true;
          break;
        }
      }
    } catch (error) {
      push(run, { type: 'error', message: error instanceof Error ? error.message : 'generation failed' });
    } finally {
      if (!sawDone) push(run, { type: 'done' });
      finish(run);
    }
  })();

  return run;
}

export function getOxwalRun(id: string): OxwalRun | null {
  return registry().get(id) ?? null;
}

/**
 * Replay everything after `afterSeq` synchronously, then keep delivering live
 * events until the run finishes. `onClose` fires exactly once. Returns an
 * unsubscribe function.
 */
export function subscribeOxwalRun(run: OxwalRun, afterSeq: number, listener: Listener, onClose: () => void): () => void {
  for (const entry of run.events) {
    if (entry.seq > afterSeq) listener(entry);
  }
  if (run.done) {
    onClose();
    return () => {};
  }
  run.listeners.add(listener);
  run.closers.add(onClose);
  return () => {
    run.listeners.delete(listener);
    run.closers.delete(onClose);
  };
}

/** SSE response for a run from `afterSeq` on. Each frame carries `id: <seq>`
 *  so the browser can resume with `?after=<seq>` (or Last-Event-ID). */
export function oxwalRunResponse(run: OxwalRun, afterSeq: number, options: { heartbeatMs?: number } = {}): Response {
  const encoder = new TextEncoder();
  const heartbeatMs = options.heartbeatMs ?? HEARTBEAT_MS;
  let unsubscribe: (() => void) | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const stop = () => {
        if (closed) return;
        closed = true;
        if (heartbeat) clearInterval(heartbeat);
        unsubscribe?.();
        try {
          controller.close();
        } catch {
          /* already closed by the client */
        }
      };
      unsubscribe = subscribeOxwalRun(
        run,
        afterSeq,
        (entry) => {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(`id: ${entry.seq}\ndata: ${stringifyRunEvent(entry.event)}\n\n`));
          } catch {
            stop();
          }
        },
        stop,
      );
      if (!closed) {
        heartbeat = setInterval(() => {
          try {
            controller.enqueue(encoder.encode(': keep-alive\n\n'));
          } catch {
            stop();
          }
        }, heartbeatMs);
      }
    },
    cancel() {
      if (heartbeat) clearInterval(heartbeat);
      unsubscribe?.();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Content-Type-Options': 'nosniff',
      'X-Accel-Buffering': 'no',
      'X-Oxwal-Run': run.id,
    },
  });
}

export function resetOxwalRunsForTests() {
  registry().clear();
}
