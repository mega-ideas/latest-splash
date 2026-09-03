'use client';

import { Eye, EyeOff } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';

import SplashLoading from '@/components/SplashLoading';
import RoadmapChip from '@/components/supply/RoadmapChip';
import { Button } from '@/components/system';
import { brand } from '@/lib/brand';
import { cn } from '@/lib/utils';

const field = 'control control--lg';

type Provider = { id: 'google' | 'microsoft'; label: string };
const PROVIDERS: Provider[] = [
  { id: 'google', label: 'Continue with Google' },
  { id: 'microsoft', label: 'Continue with Microsoft' },
];

/**
 * Email + password is the working path today. zkLogin providers render
 * only when the server says the feature is enabled; otherwise they are shown
 * disabled with a roadmap chip, never as dead buttons. No wallet language:
 * the operator signs in with an identity they already have.
 */
export default function LoginForm({ zkLogin, demo }: { zkLogin: boolean; demo: { email: string; password: string } | null }) {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(true);
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [authorizing, setAuthorizing] = useState(false);
  const [error, setError] = useState('');

  // ?demo=1 (from /sandbox) prefills the sandbox workspace credentials.
  useEffect(() => {
    if (!demo) return;
    const timer = window.setTimeout(() => {
      if (new URLSearchParams(window.location.search).get('demo') === '1') {
        setEmail(demo.email);
        setPassword(demo.password);
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, [demo]);

  const canSubmit = email.trim().length > 0 && password.length >= 6 && !submitting;

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    setError('');
    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, remember }),
      });
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) throw new Error(body.error ?? 'Unable to sign in. Check your email and password and try again.');
      setAuthorizing(true);
      router.push('/dashboard');
      router.refresh();
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : 'Unable to sign in. Check your email and password and try again.';
      setError(message);
    } finally {
      setSubmitting(false);
    }
  }

  if (authorizing) return <SplashLoading label="Securing your session" />;

  return (
    <div className="grid gap-6">
      <div className="grid gap-2">
        {PROVIDERS.map((provider) => (
          <Button key={provider.id} variant="ghost" size="lg" fullWidth disabled={!zkLogin} href={zkLogin ? `/api/auth/zklogin/start?provider=${provider.id}` : undefined} aria-describedby={zkLogin ? undefined : 'zklogin-note'}>
            {provider.label}
          </Button>
        ))}
        {!zkLogin ? (
          <div id="zklogin-note" className="flex flex-wrap items-center gap-2 text-[12px] text-[var(--text-muted)]">
            Sign in with your Google or Microsoft identity (zkLogin)
            <RoadmapChip detail="enabled per environment" />
          </div>
        ) : null}
      </div>

      <div className="flex items-center gap-3 text-[12px] text-[var(--text-muted)]" aria-hidden="true">
        <span className="h-px flex-1 bg-[var(--divider)]" />
        or with email
        <span className="h-px flex-1 bg-[var(--divider)]" />
      </div>

      <form onSubmit={onSubmit} className="grid gap-4" noValidate>
        <label className="grid gap-1.5 text-[14px] font-semibold" htmlFor="login-email">
          Business email
          <input id="login-email" type="email" required autoComplete="email" inputMode="email" placeholder="name@company.com" value={email} onChange={(event) => setEmail(event.target.value)} className={cn(field, 'font-normal')} />
        </label>
        <label className="grid gap-1.5 text-[14px] font-semibold" htmlFor="login-password">
          Password
          <span className="relative block">
            <input id="login-password" type={showPassword ? 'text' : 'password'} required minLength={6} autoComplete="current-password" placeholder="Enter your password" value={password} onChange={(event) => setPassword(event.target.value)} className={cn(field, 'pr-12 font-normal')} aria-describedby={error ? 'login-error' : undefined} aria-invalid={error ? true : undefined} />
            <button type="button" onClick={() => setShowPassword((value) => !value)} aria-label={showPassword ? 'Hide password' : 'Show password'} className="absolute right-1 top-1 grid size-10 place-items-center rounded-[var(--r-sm)] text-[var(--text-muted)] hover:bg-[var(--surface-2)]">
              {showPassword ? <EyeOff className="size-4" aria-hidden="true" /> : <Eye className="size-4" aria-hidden="true" />}
            </button>
          </span>
        </label>
        <div className="flex flex-wrap items-center justify-between gap-3 text-[14px]">
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={remember} onChange={(event) => setRemember(event.target.checked)} className="size-4 accent-[var(--teal-600)]" />
            Trust this device for 30 days
          </label>
          <Link href="/forgot-password" className="text-[var(--teal-600)] underline-offset-4 hover:underline">
            Forgot password?
          </Link>
        </div>
        {error ? (
          <p id="login-error" role="alert" className="rounded-[var(--r-sm)] border border-[var(--red-100)] bg-[var(--red-100)] px-3 py-2 text-[13px] text-[var(--red-600)]">
            {error}
          </p>
        ) : null}
        <Button type="submit" size="lg" fullWidth disabled={!canSubmit}>
          {submitting ? 'Signing in…' : 'Sign in to workspace'}
        </Button>
      </form>

      <p className="text-[14px] text-[var(--text-2)]">
        New to {brand.name}?{' '}
        <Link href="/signup" className="text-[var(--teal-600)] underline-offset-4 hover:underline">
          Create a business account
        </Link>
        {demo ? (
          <>
            {' '}
            · <Link href="/sandbox" className="text-[var(--teal-600)] underline-offset-4 hover:underline">Sandbox credentials</Link>
          </>
        ) : null}
      </p>
    </div>
  );
}
