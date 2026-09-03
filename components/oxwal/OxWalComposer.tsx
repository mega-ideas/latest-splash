'use client';

import type { Ref } from 'react';
import { useRef, useState } from 'react';
import {
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
  /** Called when the operator prepares an uploaded batch. 0xWal prepares;
   *  the human approves downstream. No-op default keeps call sites safe. */
  onFilePrepared?: (batch: ParsedBatch) => void;
  chips?: OxWalComposerChip[];
  disabled?: boolean;
  title?: string;
  placeholder?: string;
  /** Mono desk context tag, e.g. "USD→PHP · testnet". */
  deskTag?: string;
  compact?: boolean;
  className?: string;
  inputRef?: Ref<HTMLInputElement>;
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
  placeholder = 'Ask 0xWal, or attach an invoice or payout sheet',
  deskTag = 'USD→PHP · testnet',
  compact = false,
  className,
  inputRef,
}: OxWalComposerProps) {
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
        accept=".csv,.xlsx,.xls"
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
          <span className="inline-flex items-center gap-1.5 font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--slate)]">
            <span className="h-1.5 w-1.5 rounded-full bg-[var(--teal)]" aria-hidden="true" />
            {deskTag}
          </span>
          <span className="font-mono text-[10px] font-medium uppercase tracking-[0.1em] text-[var(--muted-foreground)]">
            0xWal prepares · you approve
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
                <FileSpreadsheet className="h-4 w-4 shrink-0 text-[var(--teal)]" aria-hidden="true" />
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
              'min-w-0 flex-1 bg-transparent text-left font-medium text-[var(--ink)] outline-none placeholder:text-[var(--muted-foreground)] disabled:cursor-not-allowed',
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
            aria-label={hasBatch ? 'Prepare batch for approval' : 'Prepare request for 0xWal'}
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
