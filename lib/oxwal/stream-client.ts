import type { ActionCardProposal } from '@/lib/agent/action-card';

/**
 * Browser side of a resumable 0xWal run.
 *
 * POST /api/oxwal starts the run and streams it. Every frame carries an
 * `id: <seq>`; if the read drops, the client re-attaches through
 * GET /api/oxwal/<runId>?after=<seq> with backoff, so an answer is never a
 * dead panel and a proposal is never prepared twice. Status changes are
 * reported so the surface can show a quiet "reconnecting…" line.
 */

export type OxwalStreamEvent =
  | { type: 'run'; runId: string }
  | { type: 'meta'; source: 'claude' | 'local'; readTools: string[]; proposeTools: string[] }
  | { type: 'delta'; text: string }
  | { type: 'tool'; name: string; category: 'READ' | 'PROPOSE' }
  | { type: 'warning'; warning: { code: string; message: string; ref?: string } }
  | { type: 'proposal'; proposal: ActionCardProposal }
  | { type: 'error'; message: string }
  | { type: 'done' };

export type OxwalFailureReason = 'unauthorized' | 'origin' | 'unavailable' | 'network' | 'gone';

export type OxwalStreamStatus =
  | { phase: 'connecting' }
  | { phase: 'streaming' }
  | { phase: 'reconnecting'; attempt: number; delayMs: number }
  | { phase: 'done' }
  | { phase: 'failed'; reason: OxwalFailureReason; message: string; started: boolean };

export type OxwalStreamOptions = {
  message: string;
  history: Array<{ role: 'user' | 'assistant'; content: string }>;
  onEvent: (event: OxwalStreamEvent) => void;
  onStatus?: (status: OxwalStreamStatus) => void;
  fetchImpl?: typeof fetch;
  /** Backoff schedule for resume attempts. */
  delaysMs?: number[];
  /** Backoff schedule for a POST that failed before a run started. */
  startDelaysMs?: number[];
  sleep?: (ms: number) => Promise<void>;
  jitter?: () => number;
};

export const DEFAULT_RESUME_DELAYS_MS = [600, 1200, 2400, 4800, 8000, 8000];
export const DEFAULT_START_DELAYS_MS = [800, 2000];

const RETRYABLE_START_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

export const FAILURE_MESSAGES: Record<OxwalFailureReason, string> = {
  unauthorized: 'Your session ended, so 0xWal paused. Sign in again to pick up where you left off.',
  origin: 'This page was opened from an address Splash does not recognise, so the request was refused. Open the workspace from its usual address and try again.',
  unavailable: '0xWal could not open a line just now. Nothing was prepared — try again in a moment.',
  network: 'The connection dropped and could not be recovered. Anything 0xWal did prepare is waiting in Approvals; nothing was signed.',
  gone: 'That answer expired before the connection came back. Ask again — nothing was signed.',
};

export type SseFrame = { id: number | null; data: string };

/** Split an SSE buffer into complete frames; the remainder is returned so a
 *  frame split across chunks is parsed once it is whole. Comment lines
 *  (heartbeats) are skipped. */
export function parseSseFrames(buffer: string): { frames: SseFrame[]; rest: string } {
  const parts = buffer.split('\n\n');
  const rest = parts.pop() ?? '';
  const frames: SseFrame[] = [];
  for (const part of parts) {
    let id: number | null = null;
    const data: string[] = [];
    for (const line of part.split('\n')) {
      if (line.startsWith(':')) continue;
      if (line.startsWith('id:')) {
        const parsed = Number.parseInt(line.slice(3).trim(), 10);
        id = Number.isFinite(parsed) ? parsed : null;
      } else if (line.startsWith('data:')) {
        data.push(line.slice(5).replace(/^ /, ''));
      }
    }
    if (data.length > 0) frames.push({ id, data: data.join('\n') });
  }
  return { frames, rest };
}

function defaultSleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

export async function openOxwalStream(options: OxwalStreamOptions): Promise<'done' | 'failed'> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? defaultSleep;
  const jitter = options.jitter ?? Math.random;
  const resumeDelays = options.delaysMs ?? DEFAULT_RESUME_DELAYS_MS;
  const startDelays = options.startDelaysMs ?? DEFAULT_START_DELAYS_MS;
  const status = (value: OxwalStreamStatus) => options.onStatus?.(value);

  let runId: string | null = null;
  let lastSeq = -1;
  let finished = false;

  const fail = (reason: OxwalFailureReason): 'failed' => {
    status({ phase: 'failed', reason, message: FAILURE_MESSAGES[reason], started: runId !== null });
    return 'failed';
  };

  /** Consume one response body. Resolves true when the run reported done,
   *  false when the connection ended early. Throws on read errors. */
  async function consume(response: Response): Promise<boolean> {
    if (!response.body) return false;
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parsed = parseSseFrames(buffer);
      buffer = parsed.rest;
      for (const frame of parsed.frames) {
        if (frame.id !== null && frame.id <= lastSeq) continue; // replayed duplicate
        let event: OxwalStreamEvent;
        try {
          event = JSON.parse(frame.data) as OxwalStreamEvent;
        } catch {
          continue;
        }
        if (frame.id !== null) lastSeq = frame.id;
        if (event.type === 'run') {
          runId = event.runId;
          continue;
        }
        if (event.type === 'done') {
          finished = true;
          options.onEvent(event);
          return true;
        }
        options.onEvent(event);
      }
    }
    return finished;
  }

  // 1. Start the run. A refused start never ran the agent, so retrying is safe.
  status({ phase: 'connecting' });
  let response: Response | null = null;
  for (let attempt = 0; ; attempt += 1) {
    try {
      response = await fetchImpl('/api/oxwal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // Identity and org are server-derived from the session; the client
        // sends only the message and the visible history.
        body: JSON.stringify({ message: options.message, history: options.history }),
      });
    } catch {
      response = null;
    }
    if (response?.ok && response.body) break;
    const httpStatus = response?.status ?? 0;
    if (httpStatus === 401) return fail('unauthorized');
    if (httpStatus === 403) return fail('origin');
    const retryable = response === null || RETRYABLE_START_STATUSES.has(httpStatus);
    if (!retryable || attempt >= startDelays.length) return fail(response === null ? 'network' : 'unavailable');
    const delayMs = Math.round(startDelays[attempt] * (0.8 + jitter() * 0.4));
    status({ phase: 'reconnecting', attempt: attempt + 1, delayMs });
    await sleep(delayMs);
  }

  status({ phase: 'streaming' });
  const headerRun = response.headers.get('x-oxwal-run');
  if (headerRun) runId = headerRun;

  // 2. Read, and resume from the last sequence whenever the link drops.
  let current: Response | null = response;
  let attempt = 0;
  for (;;) {
    let completed = false;
    try {
      completed = await consume(current!);
      if (completed) break;
    } catch {
      completed = false;
    }
    if (finished) break;
    if (!runId) return fail('network');
    if (attempt >= resumeDelays.length) return fail('network');
    const delayMs = Math.round(resumeDelays[attempt] * (0.8 + jitter() * 0.4));
    attempt += 1;
    status({ phase: 'reconnecting', attempt, delayMs });
    await sleep(delayMs);
    try {
      current = await fetchImpl(`/api/oxwal/${encodeURIComponent(runId)}?after=${lastSeq}`, {
        method: 'GET',
        headers: { Accept: 'text/event-stream', 'Last-Event-ID': String(lastSeq) },
        cache: 'no-store',
      });
    } catch {
      current = null;
    }
    if (current?.status === 401) return fail('unauthorized');
    if (current?.status === 404) return fail('gone');
    if (!current?.ok || !current.body) {
      current = null;
      continue;
    }
    status({ phase: 'streaming' });
    attempt = 0;
  }

  status({ phase: 'done' });
  return 'done';
}
