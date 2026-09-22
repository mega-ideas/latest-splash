'use client';

import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { ArrowLeft, ArrowRight, CheckCircle2, Mail } from 'lucide-react';
import { toast } from 'sonner';

import IsometricAuthShell from '@/components/auth/IsometricAuthShell';

type RecoveryResponse = {
  message?: string;
  recoveryEmail?: string;
  error?: string;
};

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [recovery, setRecovery] = useState<RecoveryResponse | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError('');

    try {
      const response = await fetch('/api/auth/recovery', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      const body = await response.json().catch(() => ({})) as RecoveryResponse;

      if (!response.ok) {
        throw new Error(body.error ?? 'Recovery instructions are unavailable. Try again or contact support.');
      }

      setRecovery(body);
      toast.success('Check your inbox');
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : 'Recovery instructions are unavailable. Try again or contact support.';
      setError(message);
      toast.error(message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <IsometricAuthShell
      eyebrow="Account recovery"
      title={recovery ? 'Check your inbox.' : 'Reset your password.'}
      description={recovery
        ? 'If that address has an account, a reset link is on its way. It expires in 30 minutes, and opening it ends every session that is signed in now.'
        : 'Enter your business email and we will send a link to choose a new password.'}
      art="/isometric/treasury.svg"
      artAlt="Isometric smart treasury"
      visualTitle="Secure by default"
      visualCopy="Recover access without compromising your treasury."
    >
      {recovery ? (
        <section className="iso-auth-success">
          <CheckCircle2 aria-hidden="true" />
          <h2>Check your inbox</h2>
          <p>{recovery.message}</p>
          {recovery.recoveryEmail ? (
            <Link href={`mailto:${recovery.recoveryEmail}?subject=Splash workspace recovery&body=Business email: ${encodeURIComponent(email)}`}>
              Lost the mailbox too? Contact {recovery.recoveryEmail}
            </Link>
          ) : null}
          <button type="button" onClick={() => { setRecovery(null); setError(''); }}>
            <ArrowLeft aria-hidden="true" /> Use another email
          </button>
        </section>
      ) : (
        <form onSubmit={onSubmit} className="iso-auth-form">
          <label className="iso-auth-field" htmlFor="recovery-email">
            <span>Business email</span>
            <div>
              <Mail aria-hidden="true" />
              <input
                id="recovery-email"
                type="email"
                required
                autoComplete="email"
                placeholder="name@company.com"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
            </div>
          </label>
          <button type="submit" disabled={!email.includes('@') || submitting} className="iso-auth-submit">
            {submitting ? 'Sending link...' : 'Email me a reset link'}
            {!submitting ? <ArrowRight aria-hidden="true" /> : null}
          </button>
          {error ? <p className="iso-auth-error" role="alert">{error}</p> : null}
        </form>
      )}

      <div className="iso-auth-help">
        <strong>No email after a few minutes?</strong>
        <span>Check spam, then request another link. Links work once and for 30 minutes.</span>
      </div>

      <p className="iso-auth-switch">
        Remembered your password? <Link href="/login">Back to sign in</Link>
      </p>
    </IsometricAuthShell>
  );
}
