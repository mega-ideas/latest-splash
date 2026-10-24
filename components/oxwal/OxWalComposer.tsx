'use client';

import type { Ref } from 'react';
import { useId, useRef, useState } from 'react';
import {
  ArrowRight,
  ArrowUpRight,
  FileSpreadsheet,
  FileText,
  ImageIcon,
  Mic,
  Paperclip,
  Pencil,
  Search,
  X,
} from 'lucide-react';

import { parseBatchFile, type ParsedBatch } from '@/lib/batch-parse';
import { networkChip } from '@/lib/network-label';
import { cn } from '@/lib/utils';

export type OxWalComposerChip = {
  label: string;
  prompt?: string;
  icon?: 'file' | 'image' | 'search' | 'write';
};

type OxWalComposerProps = {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onChipSubmit?: (prompt: string) => void;
  /** Called when the operator prepares an uploaded batch. Zeke prepares;
   *  the human approves downstream. No-op default keeps call sites safe. */
  onFilePrepared?: (batch: ParsedBatch) => void;
  chips?: OxWalComposerChip[];
  disabled?: boolean;
  title?: string;
  placeholder?: string;
  /** Mono desk context tag, the configured network (lib/network-label.ts). */
  deskTag?: string;
  compact?: boolean;
  className?: string;
  inputRef?: Ref<HTMLInputElement>;
  /**
   * `bar` is the payment-desk command bar (the invoice loop). `desk` is the
   * Zeke page's larger composer (board "Zeke page · start"): a three-line
   * field, the attach button, what Zeke can see, and "Ask Zeke". `reply` is
   * one line and a send arrow, for a conversation already under way and for
   * the floating Zeke.
   */
  variant?: 'bar' | 'desk' | 'reply';
  /** `desk` only: the parts of the workspace Zeke reads, shown as plain chips. */
  canSee?: string[];
};

const chipIcons = {
  file: FileText,
  image: ImageIcon,
  search: Search,
  write: Pencil,
} as const;

export default function OxWalComposer({
  value,
  onChange,
  onSubmit,
  onChipSubmit,
  onFilePrepared,
  chips = [],
  disabled = false,
  title,
  placeholder = 'Ask Zeke, or attach an invoice or payout sheet',
  deskTag = networkChip().label,
  compact = false,
  className,
  inputRef,
  variant = 'bar',
  canSee = [],
}: OxWalComposerProps) {
  const fieldId = useId();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [attached, setAttached] = useState<ParsedBatch | null>(null);
  const [parsing, setParsing] = useState(false);
  const [parseError, setParseError] = useState<string | null>(null);

  const hasValue = value.trim().length > 0;
  const hasBatch = !!attached && attached.rows.length > 0;

  async function handleFile(file: File) {
    setParsing(true);
    setParseError(null);
    try {
      const batch = await parseBatchFile(file);
      if (batch.rows.length === 0) {
        setParseError('No payable rows found. Check the file has recipient and amount columns.');
        setAttached(null);
      } else {
        setAttached(batch);
      }
    } catch (error) {
      setParseError(error instanceof Error ? error.message : 'Could not read that file.');
      setAttached(null);
    } finally {
      setParsing(false);
    }
  }

  function clearAttached() {
    setAttached(null);
    setParseError(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }

  function submit() {
    if (hasBatch && onFilePrepared && attached) {
      onFilePrepared(attached);
      clearAttached();
      return;
    }
    onSubmit();
  }

  const primaryLabel = hasBatch ? 'Prepare batch' : 'Prepare';

  const fileInput = (
    <input
      ref={fileInputRef}
      type="file"
      accept=".csv,.xlsx"
      className="hidden"
      onChange={(event) => {
        const file = event.target.files?.[0];
        if (file) void handleFile(file);
      }}
    />
  );

  /* Attached-batch pill: filename · N rows · corridor, or why it failed. */
  const attachment = (hasBatch || parsing || parseError) && (
    <div className={variant === 'bar' ? 'px-3 pt-2.5' : 'px-3 pt-3'}>
      {parsing && (
        <div className="inline-flex items-center gap-2 rounded-[var(--r-md)] border border-[var(--line)] bg-[var(--surface-2)] px-3 py-1.5 text-[13px] font-medium text-[var(--slate)]">
          <span className="h-3 w-3 animate-spin rounded-full border-2 border-[var(--teal)] border-t-transparent" aria-hidden="true" />
          Reading file…
        </div>
      )}
      {parseError && !parsing && (
        <div role="alert" className="rounded-[var(--r-md)] border border-[var(--error)]/40 bg-[var(--error-bg)] px-3 py-1.5 text-[13px] font-medium text-[var(--error)]">
          {parseError}
        </div>
      )}
      {hasBatch && !parsing && attached && (
        <div className="inline-flex max-w-full items-center gap-2 rounded-[var(--r-md)] border border-[var(--teal)]/35 bg-[var(--ok-bg)] px-3 py-1.5">
          <FileSpreadsheet className="h-4 w-4 shrink-0 text-[#326273]" aria-hidden="true" />
          <span className="truncate text-[13px] font-medium text-[var(--ink)]">{attached.fileName}</span>
          <span className="shrink-0 font-mono text-[13px] font-semibold text-[var(--slate)]">
            {attached.rows.length} {attached.rows.length === 1 ? 'row' : 'rows'} · USD→{attached.corridor}
          </span>
          <button
            type="button"
            aria-label="Remove attached file"
            onClick={clearAttached}
            className="grid h-6 w-6 shrink-0 place-items-center rounded-full text-[var(--slate)] transition hover:bg-[var(--teal)]/15 hover:text-[var(--ink)]"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      )}
    </div>
  );

  const attachButton = (size: 'sm' | 'md') => (
    <button
      type="button"
      aria-label="Attach an invoice or payout sheet (CSV or Excel)"
      title="Attach an invoice or payout sheet"
      disabled={disabled}
      onClick={() => fileInputRef.current?.click()}
      className={cn(
        'grid shrink-0 place-items-center rounded-[var(--r-md)] border border-[var(--line-strong)] bg-[var(--surface)] text-[var(--slate)] transition hover:border-[#0d6370] hover:text-[var(--ink)] disabled:cursor-not-allowed disabled:opacity-45 focus-ring',
        size === 'sm' ? 'h-10 w-10' : 'h-11 w-11',
      )}
    >
      <Paperclip className="h-[18px] w-[18px]" aria-hidden="true" />
    </button>
  );

  if (variant === 'desk') {
    return (
      <div className={cn('w-full', className)}>
        {fileInput}
        <form
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
          className={cn(
            'rounded-[14px] border-[1.5px] border-[#0d6370]/45 bg-[var(--surface)] shadow-[0_0_0_4px_rgba(13,99,112,0.07)] transition focus-within:border-[#0d6370]',
            disabled && 'opacity-75',
          )}
        >
          <label htmlFor={fieldId} className="sr-only">
            Ask Zeke
          </label>
          {attachment}
          <textarea
            id={fieldId}
            rows={3}
            value={value}
            onChange={(event) => onChange(event.target.value)}
            onKeyDown={(event) => {
              // Enter asks; Shift+Enter is a new line, as in any chat.
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                if (!disabled && (hasValue || hasBatch)) submit();
              }
            }}
            disabled={disabled}
            placeholder={hasBatch ? 'Add a note for approval (optional)' : placeholder}
            className="block w-full resize-none border-0 bg-transparent px-[18px] pb-1.5 pt-4 text-base font-medium text-[var(--ink)] outline-none placeholder:text-[var(--ink-muted)] disabled:cursor-not-allowed"
          />
          <div className="flex flex-wrap items-center justify-between gap-3 px-3 pb-3 pt-1">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              {attachButton('sm')}
              {canSee.length > 0 && (
                <>
                  <span id={`${fieldId}-sees`} className="pl-1 text-[12px] font-medium text-[var(--ink-muted)]">
                    Zeke can see
                  </span>
                  <ul aria-labelledby={`${fieldId}-sees`} className="flex flex-wrap gap-1.5">
                    {canSee.map((item) => (
                      <li
                        key={item}
                        className="rounded-[var(--r-pill)] bg-[var(--zeke-tint)] px-2.5 py-1 text-[12px] font-semibold text-[#0c3e48]"
                      >
                        {item}
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>
            <button
              type="submit"
              disabled={disabled || (!hasValue && !hasBatch)}
              className="inline-flex h-11 shrink-0 items-center gap-2 rounded-[var(--r-md)] bg-[#0c3e48] px-4 text-sm font-bold text-white transition hover:bg-[#0d6370] active:translate-y-px disabled:cursor-not-allowed disabled:opacity-40 focus-ring"
            >
              {hasBatch ? 'Prepare batch' : 'Ask Zeke'}
              <ArrowRight className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>
        </form>
      </div>
    );
  }

  if (variant === 'reply') {
    return (
      <div className={cn('w-full', className)}>
        {fileInput}
        <form
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
          className={cn(
            'rounded-[14px] border border-[#0d6370]/35 bg-[var(--surface)] transition focus-within:border-[#0d6370]',
            disabled && 'opacity-75',
          )}
        >
          {attachment}
          <div className="flex items-center gap-2 py-1.5 pl-4 pr-1.5">
            <label htmlFor={fieldId} className="sr-only">
              {placeholder}
            </label>
            <input
              id={fieldId}
              ref={inputRef}
              value={value}
              onChange={(event) => onChange(event.target.value)}
              disabled={disabled}
              placeholder={hasBatch ? 'Add a note for approval (optional)' : placeholder}
              className="min-w-0 flex-1 bg-transparent py-2 text-[15px] font-medium text-[var(--ink)] outline-none placeholder:text-[var(--ink-muted)] disabled:cursor-not-allowed"
            />
            <button
              type="button"
              aria-label="Attach an invoice or payout sheet (CSV or Excel)"
              title="Attach an invoice or payout sheet"
              disabled={disabled}
              onClick={() => fileInputRef.current?.click()}
              className="grid h-10 w-10 shrink-0 place-items-center rounded-[var(--r-md)] text-[var(--slate)] transition hover:bg-[var(--zeke-tint)] hover:text-[var(--ink)] disabled:cursor-not-allowed disabled:opacity-45 focus-ring"
            >
              <Paperclip className="h-[18px] w-[18px]" aria-hidden="true" />
            </button>
            <button
              type="submit"
              aria-label={hasBatch ? 'Prepare batch for approval' : 'Send to Zeke'}
              disabled={disabled || (!hasValue && !hasBatch)}
              className="grid h-10 w-10 shrink-0 place-items-center rounded-[var(--r-md)] bg-[#0c3e48] text-white transition hover:bg-[#0d6370] disabled:cursor-not-allowed disabled:opacity-40 focus-ring"
            >
              <ArrowRight className="h-[18px] w-[18px]" aria-hidden="true" />
            </button>
          </div>
        </form>
      </div>
    );
  }

  return (
    <div className={cn('mx-auto w-full max-w-3xl', compact && 'max-w-none', className)}>
      {title && (
        <h2 className={cn('font-medium tracking-tight text-[var(--ink)]', compact ? 'text-base' : 'text-2xl')}>
          {title}
        </h2>
      )}

      <input
        ref={fileInputRef}
        type="file"
        accept=".csv,.xlsx"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void handleFile(file);
        }}
      />

      <form
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
        className={cn(
          'mt-6 rounded-[var(--r-lg)] border border-[var(--line-strong)] bg-[var(--surface)] shadow-[var(--shadow-2)]',
          compact && 'mt-3 shadow-[var(--shadow-1)]',
          disabled && 'opacity-75',
        )}
      >
        {/* Desk header: mono context tag — reads like a payment terminal. */}
        <div className="flex items-center justify-between border-b border-[var(--line)] px-3 py-1.5">
          <span className="inline-flex items-center gap-1.5 font-mono text-[12px] font-semibold uppercase tracking-[0.12em] text-[var(--slate)]">
            <span className="h-1.5 w-1.5 rounded-full bg-[var(--teal)]" aria-hidden="true" />
            {deskTag}
          </span>
          <span className="font-mono text-[12px] font-medium uppercase tracking-[0.1em] text-[#326273]/90">
            Zeke prepares · you approve
          </span>
        </div>

        {/* Attached-batch pill: filename · N rows · corridor. */}
        {(hasBatch || parsing || parseError) && (
          <div className="px-3 pt-2.5">
            {parsing && (
              <div className="inline-flex items-center gap-2 rounded-[var(--r-md)] border border-[var(--line)] bg-[var(--surface-2)] px-3 py-1.5 text-[13px] font-medium text-[var(--slate)]">
                <span className="h-3 w-3 animate-spin rounded-full border-2 border-[var(--teal)] border-t-transparent" aria-hidden="true" />
                Reading file…
              </div>
            )}
            {parseError && !parsing && (
              <div className="rounded-[var(--r-md)] border border-[var(--error)]/40 bg-[var(--error-bg)] px-3 py-1.5 text-[13px] font-medium text-[var(--error)]">
                {parseError}
              </div>
            )}
            {hasBatch && !parsing && attached && (
              <div className="inline-flex max-w-full items-center gap-2 rounded-[var(--r-md)] border border-[var(--teal)]/35 bg-[var(--ok-bg)] px-3 py-1.5">
                <FileSpreadsheet className="h-4 w-4 shrink-0 text-[#326273]" aria-hidden="true" />
                <span className="truncate text-[13px] font-medium text-[var(--ink)]">{attached.fileName}</span>
                <span className="shrink-0 font-mono text-[13px] font-semibold text-[var(--slate)]">
                  {attached.rows.length} {attached.rows.length === 1 ? 'row' : 'rows'} · USD→{attached.corridor}
                </span>
                <button
                  type="button"
                  aria-label="Remove attached file"
                  onClick={clearAttached}
                  className="grid h-4 w-4 shrink-0 place-items-center rounded-full text-[var(--slate)] transition hover:bg-[var(--teal)]/15 hover:text-[var(--ink)]"
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            )}
          </div>
        )}

        {/* Input row. */}
        <div className={cn('flex items-center gap-2 px-2.5 py-2', compact && 'py-1.5')}>
          <button
            type="button"
            aria-label="Attach an invoice or payout sheet (CSV or Excel)"
            title="Attach invoice / Excel / CSV"
            disabled={disabled}
            onClick={() => fileInputRef.current?.click()}
            className={cn(
              'grid shrink-0 place-items-center rounded-[var(--r-md)] border border-[var(--line-strong)] text-[var(--slate)] transition hover:border-[var(--teal)] hover:text-[var(--ink)] disabled:cursor-not-allowed disabled:opacity-45',
              compact ? 'h-8 w-8' : 'h-9 w-9',
            )}
          >
            <Paperclip className={compact ? 'h-4 w-4' : 'h-[18px] w-[18px]'} />
          </button>

          <input
            ref={inputRef}
            value={value}
            onChange={(event) => onChange(event.target.value)}
            disabled={disabled}
            placeholder={hasBatch ? 'Add a note for approval (optional)' : placeholder}
            className={cn(
              'min-w-0 flex-1 bg-transparent text-left font-medium text-[var(--ink)] outline-none placeholder:text-[#326273]/90 disabled:cursor-not-allowed',
              compact ? 'text-[13px]' : 'text-sm',
            )}
          />

          <button
            type="button"
            aria-label="Voice input"
            disabled={disabled}
            className={cn(
              'grid shrink-0 place-items-center rounded-[var(--r-md)] text-[var(--slate)] transition hover:bg-[var(--surface-2)] hover:text-[var(--ink)] disabled:cursor-not-allowed disabled:opacity-45',
              compact ? 'h-8 w-8' : 'h-9 w-9',
            )}
          >
            <Mic className={compact ? 'h-4 w-4' : 'h-[18px] w-[18px]'} />
          </button>

          <button
            type="submit"
            aria-label={hasBatch ? 'Prepare batch for approval' : 'Prepare request for Zeke'}
            disabled={disabled || (!hasValue && !hasBatch)}
            className={cn(
              'inline-flex shrink-0 items-center gap-1.5 rounded-[var(--r-md)] bg-[var(--ink)] px-3.5 font-medium text-[var(--surface)] ring-1 ring-[var(--teal)]/40 shadow-[0_4px_0_var(--slate)] transition hover:bg-[var(--slate)] active:translate-y-0.5 active:shadow-[0_2px_0_var(--slate)] disabled:cursor-not-allowed disabled:opacity-40 disabled:shadow-none',
              compact ? 'h-9 text-[13px]' : 'h-10 text-sm',
            )}
          >
            <span>{primaryLabel}</span>
            <ArrowUpRight className={compact ? 'h-4 w-4' : 'h-[18px] w-[18px]'} />
          </button>
        </div>
      </form>

      {chips.length > 0 && !hasBatch && (
        <div className={cn('mt-4 flex flex-wrap gap-2.5', compact && 'mt-3 gap-2')}>
          {chips.map((chip) => {
            const Icon = chipIcons[chip.icon ?? 'file'];
            const prompt = chip.prompt ?? chip.label;
            return (
              <button
                key={chip.label}
                type="button"
                disabled={disabled}
                onClick={() => {
                  if (onChipSubmit) onChipSubmit(prompt);
                  else onChange(prompt);
                }}
                className={cn(
                  'inline-flex items-center gap-2 rounded-[var(--r-pill)] border border-[var(--line-strong)] bg-[var(--surface)] px-4 py-2 font-medium text-[var(--slate)] shadow-[var(--shadow-1)] transition hover:border-[var(--teal)] hover:text-[var(--ink)] disabled:cursor-not-allowed disabled:opacity-45',
                  compact ? 'px-3 py-1.5 text-[13px]' : 'text-sm',
                )}
              >
                <Icon className={compact ? 'h-3.5 w-3.5' : 'h-4 w-4'} />
                {chip.label}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
