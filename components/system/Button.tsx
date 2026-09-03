import Link from 'next/link';
import type { ButtonHTMLAttributes, ReactNode } from 'react';

import { cn } from '@/lib/utils';

type Variant = 'primary' | 'secondary' | 'ghost' | 'quiet' | 'destructive' | 'destructive-text';
type Size = 'sm' | 'md' | 'lg';

const base =
  'inline-flex items-center justify-center gap-2 rounded-[var(--r-control)] font-sans font-medium whitespace-nowrap select-none ' +
  'transition-[background-color,color,border-color,transform] duration-[var(--dur-ui)] ease-[var(--ease-out)] ' +
  'outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--teal-500)] ' +
  'active:translate-y-px disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0';

const variants: Record<Variant, string> = {
  primary: 'bg-[var(--teal-600)] text-white hover:bg-[var(--teal-500)]',
  secondary: 'border border-[var(--border-strong)] bg-[var(--surface-raised)] text-[var(--text)] hover:bg-[var(--surface-subtle)]',
  ghost: 'border border-[var(--line)] bg-transparent text-[var(--text)] hover:bg-[var(--surface-2)]',
  quiet: 'bg-transparent text-[var(--text-2)] hover:bg-[var(--surface-subtle)] hover:text-[var(--text)]',
  destructive: 'border border-[var(--state-exception)] bg-transparent text-[var(--state-exception)] hover:bg-[var(--state-exception)] hover:text-white',
  'destructive-text': 'bg-transparent text-[var(--error-text)] hover:bg-[var(--error-bg)]',
};

/* 44px targets on touch; md is the default control height. */
const sizes: Record<Size, string> = {
  sm: 'h-9 px-3 text-[14px]',
  md: 'h-11 px-4 text-[15px]',
  lg: 'h-12 px-5 text-[16px]',
};

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  size?: Size;
  href?: string;
  external?: boolean;
  fullWidth?: boolean;
  children: ReactNode;
};

export default function Button({
  variant = 'primary',
  size = 'md',
  href,
  external,
  fullWidth,
  className,
  children,
  type = 'button',
  ...rest
}: ButtonProps) {
  const classes = cn(base, variants[variant], sizes[size], fullWidth && 'w-full', className);
  if (href) {
    if (external) {
      return (
        <a href={href} className={classes} target="_blank" rel="noopener noreferrer">
          {children}
        </a>
      );
    }
    return (
      <Link href={href} className={classes}>
        {children}
      </Link>
    );
  }
  return (
    <button type={type} className={classes} {...rest}>
      {children}
    </button>
  );
}
