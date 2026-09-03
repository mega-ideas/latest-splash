import Link from 'next/link';
import type { ButtonHTMLAttributes, ReactNode } from 'react';

import { cn } from '@/lib/utils';

type Variant = 'primary' | 'secondary' | 'ghost' | 'quiet' | 'destructive' | 'destructive-text';
type Size = 'sm' | 'md' | 'lg';

/* Shared shape and behaviour. Focus is an offset ring so it survives on any
   surface; the press is a single pixel, not a bounce. Coarse pointers get a
   44px target regardless of size. */
const base =
  'inline-flex items-center justify-center gap-2 rounded-[var(--r-control)] font-sans font-medium whitespace-nowrap select-none ' +
  'transition-[background-color,color,border-color,box-shadow,transform] duration-[var(--dur-fast)] ease-[var(--ease-out)] ' +
  'outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--signal)] ' +
  'active:translate-y-px [&_svg]:size-4 [&_svg]:shrink-0 ' +
  'coarse:min-h-11';

/* Disabled is a real state: a muted surface you can read, not the live one at
   half strength. It keeps its own contrast so the label stays legible. */
const off = 'disabled:pointer-events-none disabled:border-[var(--border-default)] disabled:bg-[var(--surface-subtle)] disabled:text-[var(--text-muted)] disabled:shadow-none';

const variants: Record<Variant, string> = {
  primary: 'bg-[var(--signal)] text-[var(--signal-contrast)] hover:bg-[var(--signal-hover)]',
  secondary: 'border border-[var(--border-strong)] bg-[var(--surface-raised)] text-[var(--text)] hover:border-[var(--text-muted)] hover:bg-[var(--surface-subtle)]',
  ghost: 'border border-[var(--border-default)] bg-transparent text-[var(--text)] hover:border-[var(--border-strong)] hover:bg-[var(--surface-subtle)]',
  quiet: 'bg-transparent text-[var(--text-2)] hover:bg-[var(--surface-subtle)] hover:text-[var(--text)]',
  destructive: 'border border-[var(--state-exception)] bg-transparent text-[var(--state-exception)] hover:bg-[var(--state-exception)] hover:text-white',
  'destructive-text': 'bg-transparent text-[var(--error-text)] hover:bg-[var(--error-bg)]',
};

const sizes: Record<Size, string> = {
  sm: 'h-9 px-3 text-[14px]',
  md: 'h-11 px-4 text-[15px]',
  lg: 'h-12 px-5 text-[16px]',
};

const iconSizes: Record<Size, string> = { sm: 'size-9 p-0', md: 'size-11 p-0', lg: 'size-12 p-0' };

function Spinner() {
  return (
    <span
      aria-hidden="true"
      className="size-4 shrink-0 animate-spin rounded-full border-2 border-current border-r-transparent motion-reduce:animate-none"
    />
  );
}

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  size?: Size;
  href?: string;
  external?: boolean;
  fullWidth?: boolean;
  /** Shows a spinner, marks the control busy and blocks repeat submits. */
  loading?: boolean;
  /** Replaces the label while loading, e.g. "Creating proposal…". */
  loadingLabel?: string;
  children: ReactNode;
} & (
    | { iconOnly: true; 'aria-label': string }
    | { iconOnly?: false; 'aria-label'?: string }
  );

/**
 * The one button. A label says what will happen ("Create proposal", not
 * "Submit"), an async action shows its own progress rather than freezing, and
 * an icon-only button is required by the type to carry an accessible name.
 */
export default function Button({
  variant = 'primary',
  size = 'md',
  href,
  external,
  fullWidth,
  loading = false,
  loadingLabel,
  iconOnly,
  className,
  children,
  type = 'button',
  disabled,
  ...rest
}: ButtonProps) {
  const classes = cn(base, variants[variant], iconOnly ? iconSizes[size] : sizes[size], off, fullWidth && 'w-full', className);

  if (href) {
    const inner = (
      <>
        {loading ? <Spinner /> : null}
        {loading && loadingLabel ? loadingLabel : children}
      </>
    );
    if (disabled) {
      return (
        <span className={cn(classes, 'pointer-events-none border-[var(--border-default)] bg-[var(--surface-subtle)] text-[var(--text-muted)]')} aria-disabled="true" role="link">
          {inner}
        </span>
      );
    }
    if (external) {
      return (
        <a href={href} className={classes} target="_blank" rel="noopener noreferrer" {...(rest as Record<string, unknown>)}>
          {inner}
        </a>
      );
    }
    return (
      <Link href={href} className={classes} {...(rest as Record<string, unknown>)}>
        {inner}
      </Link>
    );
  }

  return (
    <button type={type} className={classes} disabled={disabled || loading} aria-busy={loading || undefined} {...rest}>
      {loading ? <Spinner /> : null}
      {loading && loadingLabel ? loadingLabel : children}
    </button>
  );
}
