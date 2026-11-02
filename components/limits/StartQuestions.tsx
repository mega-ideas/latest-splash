'use client';

import { useState } from 'react';
import { Loader2 } from 'lucide-react';

import { call } from '@/components/transfer/api';
import { Field, PrimaryButton, TextInput } from '@/components/transfer/ui';
import { ANSWER_FIELDS, QUESTIONS, proposeStart, type AnswerField, type AnswerProblems } from '@/lib/limits/start';
import type { StartWire } from '@/lib/server/business-limits';

type Values = Record<AnswerField, string>;

const EMPTY: Values = { monthlyUsdc: '', paymentsPerWeek: '', firstTransferUsdc: '' };

/**
 * The three questions a business answers about how it will use Splash (lib/limits/start.ts), in plain words, each with
 * its own label. Used on the setup page, for a new business, and on the Limits screen, for a business that has not
 * answered yet. The page reads the answers the way the server does (proposeStart), so an answer that would be refused
 * is said beside its question before anything is sent, and the server's word for it is shown the same way if it
 * disagrees. What is typed is only ever text: it is sent to the one route and never shown back as anything else.
 */
export default function StartQuestions({ onSaved, submitLabel = 'Save my answers' }: { onSaved: (start: StartWire) => void; submitLabel?: string }) {
  const [values, setValues] = useState<Values>(EMPTY);
  // An answer is judged once the person has left its field, or has tried to send.
  const [seen, setSeen] = useState<Record<AnswerField, boolean>>({ monthlyUsdc: false, paymentsPerWeek: false, firstTransferUsdc: false });
  const [tried, setTried] = useState(false);
  const [serverProblems, setServerProblems] = useState<AnswerProblems>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const local = proposeStart(values).problems;
  const problems: AnswerProblems = {};
  for (const field of ANSWER_FIELDS) {
    const shown = (tried || seen[field]) && local[field] ? local[field] : serverProblems[field];
    if (shown) problems[field] = shown;
  }

  function change(field: AnswerField, value: string) {
    setValues((current) => ({ ...current, [field]: value }));
    setServerProblems((current) => {
      if (!current[field]) return current;
      const { [field]: _gone, ...rest } = current;
      void _gone;
      return rest;
    });
  }

  async function send() {
    setTried(true);
    const first = ANSWER_FIELDS.find((field) => local[field]);
    if (first) {
      document.getElementById(`start-${first}`)?.focus();
      return;
    }
    if (busy) return;
    setBusy(true);
    setError(null);
    const answer = await call<{ start?: StartWire; error?: string; details?: { problems?: AnswerProblems } }>('/api/limits/answers', { method: 'POST', body: values });
    setBusy(false);
    if (!answer.ok || !answer.body?.start) {
      const refused = answer.body?.details?.problems;
      if (refused) {
        setServerProblems(refused);
        const field = ANSWER_FIELDS.find((f) => refused[f]);
        if (field) document.getElementById(`start-${field}`)?.focus();
      }
      setError(answer.status === 0 ? 'Could not reach Splash. Nothing was saved.' : refused ? 'Check the answers marked above. Nothing was saved.' : (answer.body?.error ?? 'Your answers were not saved. Nothing was changed.'));
      return;
    }
    onSaved(answer.body.start);
  }

  return (
    <form
      className="grid max-w-xl gap-4"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        void send();
      }}
    >
      {ANSWER_FIELDS.map((field) => {
        const id = `start-${field}`;
        const q = QUESTIONS[field];
        return (
          <div key={field}>
            <Field label={q.label} htmlFor={id} error={problems[field] ?? null} errorId={`${id}-error`}>
              <TextInput
                id={id}
                name={field}
                value={values[field]}
                onChange={(e) => change(field, e.target.value)}
                onBlur={() => setSeen((current) => ({ ...current, [field]: values[field].trim() !== '' }))}
                inputMode={field === 'paymentsPerWeek' ? 'numeric' : 'decimal'}
                autoComplete="off"
                maxLength={60}
                className="tabular-nums"
                aria-invalid={problems[field] ? true : undefined}
                aria-describedby={problems[field] ? `${id}-hint ${id}-error` : `${id}-hint`}
              />
            </Field>
            <p id={`${id}-hint`} className="mt-1.5 text-[13px] leading-5 text-[#326273]">{q.hint}</p>
          </div>
        );
      })}
      <div role="status" className="empty:hidden">
        {error ? <p role="alert" className="rounded-lg bg-[var(--error-bg)] px-3 py-2 text-[13px] font-medium text-[var(--error)]">{error}</p> : null}
      </div>
      <PrimaryButton type="submit" disabled={busy} className="w-fit">
        {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
        {submitLabel}
      </PrimaryButton>
    </form>
  );
}
