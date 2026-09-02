'use client';

import { Paperclip, SendHorizontal } from 'lucide-react';
import { forwardRef, useEffect, useImperativeHandle, useRef, useState, type KeyboardEvent } from 'react';

import { cn } from '@/lib/utils';

export type ChatComposerHandle = { focus: () => void; clear: () => void };

/**
 * Agent composer: auto-growing textarea, Enter sends, Shift+Enter breaks,
 * 16px text (no iOS zoom), safe-area padding when docked. The "prepare"
 * verb is deliberate: the agent proposes; a human approves.
 */
const ChatComposer = forwardRef<ChatComposerHandle, {
  onSubmit: (text: string) => void;
  onAttach?: () => void;
  placeholder?: string;
  disabled?: boolean;
  docked?: boolean;
  submitLabel?: string;
  hint?: string;
  className?: string;
}>(function ChatComposer({ onSubmit, onAttach, placeholder = 'Ask 0xWal, or attach an invoice or payout sheet', disabled, docked, submitLabel = 'Prepare', hint, className }, ref) {
  const [value, setValue] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useImperativeHandle(ref, () => ({
    focus: () => textareaRef.current?.focus(),
    clear: () => setValue(''),
  }));

  useEffect(() => {
    const node = textareaRef.current;
    if (!node) return;
    node.style.height = 'auto';
    node.style.height = `${Math.min(node.scrollHeight, 200)}px`;
  }, [value]);

  function submit() {
    const text = value.trim();
    if (!text || disabled) return;
    onSubmit(text);
    setValue('');
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
      className={cn(
        'grid gap-2 rounded-[var(--r-lg)] border border-[var(--line)] bg-[var(--surface)] p-2 shadow-[var(--shadow-elevated)]',
        docked && 'pb-[calc(0.5rem+env(safe-area-inset-bottom))]',
        className,
      )}
    >
      <label className="sr-only" htmlFor="chat-composer-input">
        Message 0xWal
      </label>
      <textarea
        id="chat-composer-input"
        ref={textareaRef}
        rows={1}
        value={value}
        disabled={disabled}
        placeholder={placeholder}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={onKeyDown}
        className="max-h-[200px] w-full resize-none bg-transparent px-3 py-2 text-[16px] leading-[1.5] text-[var(--text)] outline-none placeholder:text-[var(--text-muted)]"
      />
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1">
          {onAttach ? (
            <button
              type="button"
              onClick={onAttach}
              disabled={disabled}
              aria-label="Attach an invoice or payout sheet"
              className="flex size-11 items-center justify-center rounded-[var(--r-sm)] text-[var(--text-2)] outline-none hover:bg-[var(--surface-2)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--teal-500)]"
            >
              <Paperclip className="size-4" aria-hidden="true" />
            </button>
          ) : null}
          {hint ? <span className="hidden font-mono text-[11px] text-[var(--text-muted)] sm:inline">{hint}</span> : null}
        </div>
        <button
          type="submit"
          disabled={disabled || value.trim().length === 0}
          className="inline-flex h-11 items-center gap-2 rounded-[var(--r-sm)] bg-[var(--teal-600)] px-4 text-[14px] font-semibold text-white outline-none transition-colors hover:bg-[var(--teal-500)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--teal-500)] disabled:opacity-50"
        >
          {submitLabel}
          <SendHorizontal className="size-4" aria-hidden="true" />
        </button>
      </div>
    </form>
  );
});

export default ChatComposer;
