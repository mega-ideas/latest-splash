'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { call, errorText } from '@/components/transfer/api';
import type { ActionCardProposal } from '@/lib/agent/action-card';
import { DEFAULT_ASSISTANT_NAME } from '@/lib/agent/assistant-name-shared';
import { SHEET_COPY } from '@/lib/agent/sheet-copy';
import { sendSheet, type SheetPayload } from '@/lib/batch/file';
import { newBatchKey } from '@/lib/batch/key';
import { recordPendingProposals } from '@/lib/oxwal-notify';
import { takeThreadHandoff } from '@/lib/oxwal/thread-handoff';
import type { SheetCard } from '@/lib/server/zeke-batch-sheet';

/**
 * One conversation with Zeke, for every surface that has one.
 *
 * ─── Why this exists ────────────────────────────────────────────────────────
 *
 * There were three chat surfaces and two agents. The desk talked to
 * `/api/oxwal` — the real thing, with read and propose tools, unsigned action
 * cards and an approval path. The copilot page and the floating widget talked
 * to `/api/copilot/chat`, which has no tools, and when that failed they fell
 * back to a local keyword matcher that answered payroll questions with
 * hard-coded rates.
 *
 * That last part is the reason this is a rewrite and not a restyle. A finance
 * operator asking "what is the PHP rate" was shown `56.42` from a string
 * literal, in the same typeface, the same bubble and the same confident tone as
 * a real quote. Nothing on screen distinguished them. An interface that invents
 * a number an operator might act on is worse than one that says it does not
 * know, and the fabricated answers were the *fallback* — the path taken exactly
 * when the real system was unreachable.
 *
 * So there is now one engine, it is the tool-using one, and when it cannot
 * answer it says so.
 *
 * ─── What the caller gets ───────────────────────────────────────────────────
 *
 * State plus two actions. Everything the agent does surfaces in `thread` in
 * order — reads as quiet activity lines, warnings as amber notes, prepared
 * payments as unsigned proposals. The ordering is the point: an operator
 * reading "Verifying counterparty" directly above a proposal can see what the
 * recommendation was built from.
 */

export type OxwalThreadItem =
  | { kind: 'user'; id: string; text: string }
  | { kind: 'assistant'; id: string; text: string }
  | { kind: 'activity'; id: string; label: string; tone: 'read' | 'propose' }
  | { kind: 'notice'; id: string; text: string; retryPrompt?: string }
  | { kind: 'session-expired'; id: string }
  | { kind: 'proposal'; id: string; proposal: ActionCardProposal }
  /** A USDC transfer Zeke prepared for the operator to review and send. */
  | { kind: 'handoff'; id: string; handoff: OxwalHandoff }
  /**
   * A payout sheet a person attached or pasted: read by the server, shown as a
   * table to check, and prepared in the wallet batch flow when the person says
   * so. Never part of the history sent to the model.
   */
  | { kind: 'sheet'; id: string; sheet: OxwalSheetState };

export type OxwalHandoff = { title: string; lines: string[]; href: string; cta: string };

export type OxwalSheetState =
  | { phase: 'reading'; name: string | null }
  | { phase: 'failed'; text: string }
  | { phase: 'review'; card: SheetCard; confirmed: boolean; preparing: boolean; error: string | null; intentKey: string }
  | { phase: 'prepared'; card: SheetCard; batch: { id: string; status: string } };

/**
 * In-chat approval window per proposal. `waiting` counts down; an unapproved
 * proposal then falls back to the maker-checker queue — where it already is.
 * The window is a convenience, never a second authority.
 */
export type OxwalChatApproval = {
  state: 'waiting' | 'approving' | 'approved' | 'expired' | 'blocked';
  expiresAt: number;
  note?: string;
};

export const CHAT_APPROVAL_WINDOW_MS = 120_000;

type OxwalStreamEvent =
  | {
      type: 'meta';
      /** Which backend is being tried, not who answered — see the done frame. */
      attempting: 'claude' | 'local' | 'scripted';
      readTools: string[];
      proposeTools: string[];
      assistantName?: string;
    }
  | { type: 'delta'; text: string }
  | { type: 'tool'; name: string; category: 'READ' | 'PROPOSE' }
  | { type: 'warning'; warning: { code: string; message: string; ref?: string } }
  | { type: 'proposal'; proposal: ActionCardProposal }
  | { type: 'handoff'; handoff: OxwalHandoff }
  | { type: 'done'; source: 'claude' | 'local' | 'scripted' };

/**
 * The operator sees what Zeke is doing, never which backend does it.
 *
 * Every tool in the registry is named here. A tool that reaches the UI without
 * a label reads as "Working", which tells an operator nothing about what was
 * consulted — and the whole purpose of the activity trail is that they can see
 * what the answer was built from.
 */
const ACTIVITY_LABELS: Record<string, string> = {
  getBalances: 'Reading balances',
  getTreasuryState: 'Reading treasury state',
  getCorridorLiquidity: 'Checking corridor liquidity',
  getRate: 'Fetching FX rate',
  getCounterparty: 'Verifying counterparty',
  getInvoice: 'Reading invoice',
  getNettingOpportunities: 'Scanning netting opportunities',
  getComplianceStatus: 'Checking compliance',
  findSavedRecipient: 'Looking up saved recipient',
  listSavedRecipients: 'Listing saved recipients',
  proposePayment: 'Preparing payment proposal',
  proposeInternalTransfer: 'Preparing internal transfer',
  proposeFxConvert: 'Preparing FX conversion',
  proposeTreasuryAllocation: 'Preparing treasury allocation',
  proposeTreasuryRedeem: 'Preparing treasury redemption',
  proposeNettingSettlement: 'Preparing netting settlement',
  proposeRecipientFromInvoice: 'Reading recipient off the invoice',
  setAssistantName: 'Remembering what to be called',
  quoteX402Payment: 'Pricing the x402 request',
  proposeX402Payment: 'Preparing x402 proposal',
  prepareUsdcTransfer: 'Preparing USDC transfer',
};

export function activityLabel(tool: string): string {
  return ACTIVITY_LABELS[tool] ?? 'Working';
}

function newId(prefix: string) {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

export type UseOxwalThreadOptions = {
  /** The first assistant turn. Omit for a surface that opens empty. */
  welcome?: string;
  /** How many prior turns to send back. The route caps at 12 regardless. */
  historyTurns?: number;
  /**
   * Whether prepared proposals may be approved inside the thread. The floating
   * widget sets this false: it is 380px of chrome floating over another screen,
   * and approving a payment there means approving it without the space to read
   * it. That surface links to the queue instead.
   */
  allowInlineApproval?: boolean;
  /**
   * Take over a conversation another surface handed over (the floating
   * Zeke's expand button, lib/oxwal/thread-handoff.ts). The Zeke page sets it.
   */
  resumeHandoff?: boolean;
};

export function useOxwalThread(options: UseOxwalThreadOptions = {}) {
  const { welcome, historyTurns = 8, allowInlineApproval = true, resumeHandoff = false } = options;

  const [thread, setThread] = useState<OxwalThreadItem[]>(() =>
    welcome ? [{ kind: 'assistant', id: 'assistant_welcome', text: welcome }] : [],
  );
  const [streamingText, setStreamingText] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [chatApprovals, setChatApprovals] = useState<Record<string, OxwalChatApproval>>({});
  const [clockMs, setClockMs] = useState(() => Date.now());
  const [assistantName, setAssistantName] = useState(DEFAULT_ASSISTANT_NAME);

  const hasStarted = thread.some((item) => item.kind === 'user' || item.kind === 'sheet');

  // The thread as the latest render saw it, for actions that act on one of its rows.
  const latest = useRef(thread);
  useEffect(() => {
    latest.current = thread;
  }, [thread]);

  // A conversation handed over from the floating Zeke continues here. Read
  // after mount, in the browser only, and taken once.
  useEffect(() => {
    if (!resumeHandoff) return;
    // Taken inside the timeout, not the effect: under Strict Mode the effect
    // runs twice, and the first run's cleanup cancels its timeout before
    // anything was taken, so the second run still finds the handover.
    const timeout = setTimeout(() => {
      const handoff = takeThreadHandoff();
      if (!handoff) return;
      const welcomeRow: OxwalThreadItem[] = welcome ? [{ kind: 'assistant', id: 'assistant_welcome', text: welcome }] : [];
      setThread([...welcomeRow, ...handoff.thread.filter((item) => item.id !== 'assistant_welcome')]);
      if (handoff.assistantName) setAssistantName(handoff.assistantName.slice(0, 40));
    }, 0);
    return () => clearTimeout(timeout);
  }, [resumeHandoff, welcome]);

  const proposals = useMemo(
    () => thread.flatMap((item) => (item.kind === 'proposal' ? [item.proposal] : [])),
    [thread],
  );

  // Tick while any in-chat window is open, and expire the ones that ran out.
  const hasOpenWindow = Object.values(chatApprovals).some((entry) => entry.state === 'waiting');
  useEffect(() => {
    if (!hasOpenWindow) return;
    const interval = window.setInterval(() => {
      const now = Date.now();
      setClockMs(now);
      setChatApprovals((current) => {
        let changed = false;
        const next: Record<string, OxwalChatApproval> = {};
        for (const [id, entry] of Object.entries(current)) {
          if (entry.state === 'waiting' && now >= entry.expiresAt) {
            next[id] = { ...entry, state: 'expired' };
            changed = true;
          } else {
            next[id] = entry;
          }
        }
        return changed ? next : current;
      });
    }, 1000);
    return () => window.clearInterval(interval);
  }, [hasOpenWindow]);

  // Let the floating Zeke remind the operator elsewhere in the app. A proposal
  // stays pending until approved — in chat or in the queue.
  useEffect(() => {
    if (proposals.length === 0) return;
    const unresolved = proposals.filter((p) => chatApprovals[p.id]?.state !== 'approved');
    recordPendingProposals({
      count: unresolved.length,
      label: unresolved[unresolved.length - 1]?.explain.recommendation ?? null,
    });
  }, [proposals, chatApprovals]);

  const submitPrompt = useCallback(
    async (rawPrompt: string) => {
      const prompt = rawPrompt.trim();
      if (!prompt || isSending) return;

      // The welcome line is the surface's, not a turn the agent took, and a
      // history that opens with an assistant turn is not a conversation the
      // model API accepts as one; it stays on screen and out of the history.
      const history = thread
        .flatMap((item) =>
          (item.kind === 'user' || item.kind === 'assistant') && item.id !== 'assistant_welcome'
            ? [{ role: item.kind, content: item.text }]
            : [],
        )
        .slice(-historyTurns);

      setStreamingText('');
      setIsSending(true);
      setThread((current) => [...current, { kind: 'user', id: newId('user'), text: prompt }]);

      let assistantText = '';
      try {
        const response = await fetch('/api/oxwal', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          // Track A §1.1: identity and org are server-derived from the session;
          // sending authority-shaped fields is a provenance violation (400).
          body: JSON.stringify({ message: prompt, history }),
        });

        if (response.status === 401) {
          setThread((current) => [...current, { kind: 'session-expired', id: newId('expired') }]);
          return;
        }
        if (!response.ok || !response.body) {
          setThread((current) => [
            ...current,
            {
              kind: 'notice',
              id: newId('notice'),
              text: 'Zeke could not open a secure line just now. Nothing was prepared — try again.',
              retryPrompt: prompt,
            },
          ]);
          return;
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        const flushAssistant = () => {
          const text = assistantText.trim();
          if (text) {
            setThread((current) => [
              ...current,
              { kind: 'assistant', id: newId('assistant'), text },
            ]);
          }
          assistantText = '';
          setStreamingText('');
        };

        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const frames = buffer.split('\n\n');
          buffer = frames.pop() ?? '';

          for (const frame of frames) {
            const line = frame.split('\n').find((item) => item.startsWith('data: '));
            if (!line) continue;
            const event = JSON.parse(line.slice(6)) as OxwalStreamEvent;

            if (event.type === 'meta' && event.assistantName) {
              setAssistantName(event.assistantName);
            }

            if (event.type === 'tool') {
              // A tool call means the current text turn ended — commit it so
              // the activity line lands between turns, in order.
              flushAssistant();
              setThread((current) => [
                ...current,
                {
                  kind: 'activity',
                  id: newId('tool'),
                  label: activityLabel(event.name),
                  tone: event.category === 'PROPOSE' ? 'propose' : 'read',
                },
              ]);
            }

            if (event.type === 'warning') {
              flushAssistant();
              setThread((current) => [
                ...current,
                { kind: 'notice', id: newId('notice'), text: event.warning.message },
              ]);
            }

            if (event.type === 'proposal') {
              flushAssistant();
              const proposalId = event.proposal.id;
              if (allowInlineApproval) {
                setChatApprovals((current) => ({
                  ...current,
                  [proposalId]: {
                    state: 'waiting',
                    expiresAt: Date.now() + CHAT_APPROVAL_WINDOW_MS,
                  },
                }));
              }
              setThread((current) => [
                ...current,
                { kind: 'proposal', id: newId('proposal'), proposal: event.proposal },
              ]);
            }

            if (event.type === 'handoff') {
              // Text first, then the card: "I've prepared it…" reads above it.
              flushAssistant();
              setThread((current) => [
                ...current,
                { kind: 'handoff', id: newId('handoff'), handoff: event.handoff },
              ]);
            }

            if (event.type === 'delta') {
              assistantText += event.text;
              setStreamingText(assistantText);
            }
          }
        }

        flushAssistant();
      } catch {
        setThread((current) => [
          ...current,
          {
            kind: 'notice',
            id: newId('notice'),
            text: 'The connection dropped mid-answer. Nothing was prepared without you — try again.',
            retryPrompt: prompt,
          },
        ]);
      } finally {
        setStreamingText('');
        setIsSending(false);
      }
    },
    [thread, isSending, historyTurns, allowInlineApproval],
  );

  const patchSheet = useCallback((id: string, next: OxwalSheetState) => {
    setThread((current) => current.map((item) => (item.kind === 'sheet' && item.id === id ? { ...item, sheet: next } : item)));
  }, []);

  const sessionEnded = useCallback((id: string) => {
    setThread((current) => [...current.filter((item) => item.id !== id), { kind: 'session-expired', id: newId('expired') }]);
  }, []);

  /**
   * A payout sheet, attached or pasted. The server reads it and checks every
   * row with the review Batch payouts uses; the table comes back to this
   * thread. It is never sent to the model, and nothing is prepared yet.
   */
  const attachSheet = useCallback(
    async (payload: SheetPayload) => {
      const id = newId('sheet');
      setThread((current) => [...current, { kind: 'sheet', id, sheet: { phase: 'reading', name: payload.name } }]);
      const answer = await sendSheet<{ card?: SheetCard }>(payload, { review: true });
      if (answer.status === 401) return sessionEnded(id);
      if (answer.ok && answer.body?.card) {
        patchSheet(id, { phase: 'review', card: answer.body.card, confirmed: false, preparing: false, error: null, intentKey: newBatchKey() });
      } else {
        patchSheet(id, { phase: 'failed', text: errorText(answer, SHEET_COPY.readFailed) });
      }
    },
    [patchSheet, sessionEnded],
  );

  const confirmSheet = useCallback((id: string, confirmed: boolean) => {
    setThread((current) =>
      current.map((item) => (item.kind === 'sheet' && item.id === id && item.sheet.phase === 'review' ? { ...item, sheet: { ...item.sheet, confirmed } } : item)),
    );
  }, []);

  const dismissSheet = useCallback((id: string) => {
    setThread((current) => current.filter((item) => item.id !== id));
  }, []);

  /**
   * Prepare the batch: the wallet batch flow's own route, with the rows the
   * table showed and the fee it showed. An owner's batch becomes one signing
   * request for the owners; a staff member's waits for an owner. The same
   * intent id is used for a retry, so pressing twice makes one batch. Nothing
   * is sent or approved here, and the person's yes to repeats and new payees
   * is the checkbox they ticked.
   */
  const prepareSheet = useCallback(
    async (id: string) => {
      const item = latest.current.find((row) => row.kind === 'sheet' && row.id === id);
      if (!item || item.kind !== 'sheet' || item.sheet.phase !== 'review') return;
      const { card, confirmed, intentKey, preparing } = item.sheet;
      if (preparing || !card.ready || (card.needsConfirmation && !confirmed)) return;
      patchSheet(id, { ...item.sheet, preparing: true, error: null });
      const label = `Zeke · ${card.fileName ?? 'pasted rows'}`.slice(0, 80);
      const answer = await call<{ batch?: { id: string; status: string } }>('/api/wallet/batches', {
        body: { rows: card.sheet, maxFeeMinor: card.maxFeeMinor, label, confirmDuplicates: confirmed, confirmNewPayees: confirmed },
        key: intentKey,
      });
      if (answer.status === 401) return sessionEnded(id);
      if (answer.ok && answer.body?.batch) {
        patchSheet(id, { phase: 'prepared', card, batch: { id: answer.body.batch.id, status: answer.body.batch.status } });
      } else {
        patchSheet(id, { ...item.sheet, preparing: false, error: errorText(answer, 'The batch could not be prepared just now. Nothing was prepared.') });
      }
    },
    [patchSheet, sessionEnded],
  );

  const approveInChat = useCallback(async (proposal: ActionCardProposal) => {
    setChatApprovals((current) => ({
      ...current,
      [proposal.id]: {
        ...current[proposal.id],
        state: 'approving',
        expiresAt: current[proposal.id]?.expiresAt ?? 0,
      },
    }));
    try {
      const response = await fetch(`/api/proposals/${encodeURIComponent(proposal.id)}/submit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // The server derives who is approving from the session; the client
        // sends only its signature ref and the hash of what it reviewed.
        body: JSON.stringify({
          signatureRef: `sig_chat_${proposal.id}`,
          approvalHash: proposal.approvalHash,
        }),
      });
      if (response.ok) {
        setChatApprovals((current) => ({
          ...current,
          [proposal.id]: { state: 'approved', expiresAt: 0 },
        }));
        return;
      }
      const body = (await response.json().catch(() => null)) as { error?: string } | null;
      setChatApprovals((current) => ({
        ...current,
        [proposal.id]: {
          state: 'blocked',
          expiresAt: 0,
          note: body?.error ?? 'Policy requires this one to go through the approval queue.',
        },
      }));
    } catch {
      setChatApprovals((current) => ({
        ...current,
        [proposal.id]: {
          state: 'blocked',
          expiresAt: 0,
          note: 'Connection dropped — approve it from the queue instead.',
        },
      }));
    }
  }, []);

  /**
   * Start a new conversation: the thread goes back to its welcome, and
   * in-chat approval windows close. What was prepared stays where it is, in
   * the approval queue, so nothing waiting is lost by starting over.
   */
  const resetThread = useCallback(() => {
    if (isSending) return;
    setThread(welcome ? [{ kind: 'assistant', id: 'assistant_welcome', text: welcome }] : []);
    setChatApprovals({});
    setStreamingText('');
  }, [isSending, welcome]);

  /** Keep the newest turn in view while the conversation grows or streams. */
  const threadRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = threadRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }, [thread, streamingText]);

  return {
    thread,
    streamingText,
    isSending,
    chatApprovals,
    clockMs,
    hasStarted,
    proposals,
    assistantName,
    threadRef,
    submitPrompt,
    attachSheet,
    confirmSheet,
    prepareSheet,
    dismissSheet,
    approveInChat,
    resetThread,
  };
}
