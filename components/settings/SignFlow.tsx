'use client';

import { call, errorText, type SigningView } from '@/components/transfer/api';
import SignPanel, { type SignLabels } from '@/components/transfer/SignPanel';
import { askFailureText } from '@/lib/team-rules/states';

/** What the signing screen says for a change to a rule, the policy or a plan: the owners sign it on their own devices, and it takes effect at once. */
export const CHANGE_LABELS: SignLabels = {
  working: 'Sending your change',
  done: 'Signed and sent',
  doneNote: 'The change is on your business wallet and takes effect at once.',
  deadNote: 'Nothing was changed. You can start again.',
  restart: 'Start again',
};

export type Asked = { ok: true; request: SigningView; body: Record<string, unknown> } | { ok: false; error: string };

/**
 * Ask the owners to sign a change. Every spending-rule, policy and plan route
 * answers with the signing request it opened (built by the server from the
 * session's own business, decoded and checked before anyone is asked); this
 * returns it, or the reason it was refused in the server's words. Nothing is
 * signed here.
 */
export async function askToSign(url: string, init: { method?: string; body?: unknown }): Promise<Asked> {
  const answer = await call<{ request?: SigningView } & Record<string, unknown>>(url, { method: init.method ?? 'POST', body: init.body ?? {} });
  if (!answer.ok || !answer.body?.request) {
    const code = answer.body && typeof answer.body.code === 'string' ? answer.body.code : undefined;
    return { ok: false, error: askFailureText({ status: answer.status, code, error: errorText(answer, '') }, 'other') };
  }
  return { ok: true, request: answer.body.request, body: answer.body };
}

/** The signing panel for a request just opened: the owner's own device decodes the bytes and signs. */
export default function SignFlow({ request, onDone, onCancel }: { request: SigningView; onDone: () => void; onCancel: () => void }) {
  return <SignPanel initial={request} labels={CHANGE_LABELS} onExecuted={() => onDone()} onRestart={onCancel} />;
}
