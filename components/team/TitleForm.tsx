'use client';

import { useId, useState } from 'react';

import { call, errorText } from '@/components/transfer/api';
import { Field, PrimaryButton, TextInput } from '@/components/transfer/ui';
import { Note } from '@/components/wallet/parts';
import { TITLE_HELP, TITLE_MAX } from '@/lib/team/member-title';

/**
 * One person's job title, the "(CFO)" in "Aisha (CFO)": a single text field and its own Save button,
 * shared by "Your title" (everyone, for themselves) and Manage (an owner, for someone else).
 *
 * Nothing is saved by a keystroke. The server cleans the title to plain words and answers with what it
 * kept, so the field shows what was saved, not what was typed. Empty clears it, and the role word is
 * used again. Words that are not words (a link, markup, only numbers) are refused with the reason
 * beside the field and nothing is changed.
 */
export default function TitleForm({
  userId,
  current,
  label,
  whose,
  roleWord,
  autoComplete = 'off',
  onChanged,
}: {
  userId: string;
  current: string | null;
  label: string;
  /** Who the title belongs to, in the words of the confirmation: "Your" or "Ben’s". */
  whose: string;
  /** What is said when there is no title: "Owner", "Staff", "Finance lead"… */
  roleWord: string;
  autoComplete?: string;
  onChanged: () => void;
}) {
  const id = useId();
  const [value, setValue] = useState(current ?? '');
  const [saved, setSaved] = useState(current ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const changed = value.trim() !== saved;

  async function save() {
    if (busy) return;
    setBusy(true);
    setError(null);
    setDone(null);
    const answer = await call<{ changed?: boolean; title?: string | null }>(`/api/team/members/${encodeURIComponent(userId)}/title`, { method: 'PUT', body: { title: value.trim() === '' ? null : value } });
    setBusy(false);
    if (!answer.ok) {
      setError(errorText(answer, 'That did not work. Nothing was changed.'));
      return;
    }
    const kept = typeof answer.body?.title === 'string' ? answer.body.title : '';
    setValue(kept);
    setSaved(kept);
    setDone(kept === '' ? `Title cleared. ${roleWord} is used instead.` : `${whose} title is ${kept}.`);
    onChanged();
  }

  return (
    <form
      className="space-y-2"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <Field label={label} htmlFor={`${id}-input`} hint={`${Array.from(value).length} of ${TITLE_MAX}`}>
        <TextInput
          id={`${id}-input`}
          type="text"
          value={value}
          maxLength={TITLE_MAX}
          autoComplete={autoComplete}
          spellCheck={false}
          placeholder={roleWord}
          aria-describedby={`${id}-help`}
          onChange={(event) => setValue(event.target.value)}
        />
      </Field>
      <p id={`${id}-help`} className="text-[13px] leading-5 text-[#326273]">{TITLE_HELP}</p>
      <PrimaryButton type="submit" disabled={busy || !changed}>{busy ? 'Saving…' : 'Save title'}</PrimaryButton>
      <div aria-live="polite">{done && !busy ? <Note>{done}</Note> : null}</div>
      {error ? <Note tone="error">{error}</Note> : null}
    </form>
  );
}
