'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { ActionCardProposal } from '@/lib/agent/action-card';
import { DEFAULT_ASSISTANT_NAME } from '@/lib/agent/assistant-name-shared';
import { recordPendingProposals } from '@/lib/oxwal-notify';

/**
 * One conversation with 0xWal, for every surface that has one.
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
  | { kind: 'proposal'; id: string; proposal: ActionCardProposal };

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
  | { type: 'done'; source: 'claude' | 'local' | 'scripted' };

/**
 * The operator sees what 0xWal is doing, never which backend does it.
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
  proposeBatchPayout: 'Preparing batch payout',
  proposeRecipientFromInvoice: 'Reading recipient off the invoice',
  setAssistantName: 'Remembering what to be called',
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
};

export function useOxwalThread(options: UseOxwalThreadOptions = {}) {
  const { welcome, historyTurns = 8, allowInlineApproval = true } = options;

  const [thread, setThread] = useState<OxwalThreadItem[]>(() =>
    welcome ? [{ kind: 'assistant', id: 'assistant_welcome', text: welcome }] : [],
  );
  const [streamingText, setStreamingText] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [chatApprovals, setChatApprovals] = useState<Record<string, OxwalChatApproval>>({});
  const [clockMs, setClockMs] = useState(() => Date.now());
  const [assistantName, setAssistantName] = useState(DEFAULT_ASSISTANT_NAME);

  const hasStarted = thread.some((item) => item.kind === 'user');

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

  // Let the floating 0xWal remind the operator elsewhere in the app. A proposal
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

      const history = thread
        .flatMap((item) =>
          item.kind === 'user' || item.kind === 'assistant'
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
              text: '0xWal could not open a secure line just now. Nothing was prepared — try again.',
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
    approveInChat,
  };
}
