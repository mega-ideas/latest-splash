'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useState, type FormEvent, type ReactNode } from 'react';
import { ArrowRight, CheckCircle2, Mail } from 'lucide-react';
import { toast } from 'sonner';

import IsometricAuthShell from '@/components/auth/IsometricAuthShell';
import PasswordFromLinkForm from '@/components/auth/PasswordFromLinkForm';

/**
 * Where the confirmation link lands.
 *
 * With a token: choose a password, and the mailbox is proven. Without one,
 * or with one that is spent or expired: ask for a new link. The page never
 * signs anyone in — proving an address is not the same as being granted
 * anything, and the sign-in that follows uses the password chosen here.
 */
export default function VerifyEmailPage() {
  // useSearchParams needs a Suspense boundary above it for the production
  // build; the fallback is the same shell with nothing in it yet.
  return (
    <Suspense fallback={<Shell title="Confirm your email." description="One moment." />}>
      <VerifyEmail />
    </Suspense>
  );
}

function Shell(props: { title: string; description: string; children?: ReactNode }) {
  return (
    <IsometricAuthShell
      eyebrow="Confirm your email"
      title={props.title}
      description={props.description}
      art="/isometric/payment-intent.svg"
      artAlt="Isometric atomic payment intent"
      visualTitle="One address, one owner"
      visualCopy="Only the person who reads the mailbox can finish creating the account."
    >
      {props.children}
      <p className="iso-auth-switch">
        Already confirmed? <Link href="/login">Sign in</Link>
      </p>
    </IsometricAuthShell>
  );
}

type Stage = 'set' | 'done' | 'resend';

function VerifyEmail() {
  const params = useSearchParams();
  const token = params.get('token')?.trim() ?? '';
  const [stage, setStage] = useState<Stage>(token ? 'set' : 'resend');
  const [linkProblem, setLinkProblem] = useState(false);

  if (stage === 'done') {
    return (
      <Shell title="Email confirmed." description="Your address is proven and your password is set.">
        <section className="iso-auth-success">
          <CheckCircle2 aria-hidden="true" />
          <h2>You can sign in now</h2>
          <p>
            Use the password you just chose. An administrator still has to grant this account access to a workspace
            before it can act on anything.
          </p>
          <Link href="/login">
            Go to sign in <ArrowRight aria-hidden="true" />
          </Link>
        </section>
      </Shell>
    );
  }

  if (stage === 'set') {
    return (
      <Shell title="Confirm your email." description="Choose the password for this account. The link proves the address is yours.">
        <PasswordFromLinkForm
          endpoint="/api/auth/verify-email"
          token={token}
          submitLabel="Confirm and set password"
          busyLabel="Confirming..."
          successToast="Email confirmed"
          onDone={() => setStage('done')}
          onInvalidLink={() => {
            setLinkProblem(true);
            setStage('resend');
          }}
        />
        <div className="iso-auth-help">
          <strong>Why a new password?</strong>
          <span>Whoever opens this link owns the account. Any password entered before now stops working.</span>
        </div>
      </Shell>
    );
  }

  return (
    <Shell
      title={linkProblem ? 'That link has expired.' : 'Need a new link?'}
      description={
        linkProblem
          ? 'Links work once and for 30 minutes. Enter your address and we will send another.'
          : 'Enter the address you signed up with and we will send a fresh confirmation link.'
      }
    >
      <ResendForm />
    </Shell>
  );
}

function ResendForm() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError('');
    try {
      const response = await fetch('/api/auth/verify-email/resend', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      const body = (await response.json().catch(() => ({}))) as { message?: string; error?: string };
      if (!response.ok) throw new Error(body.error ?? 'The link could not be sent. Try again shortly.');
      setSent(body.message ?? 'If that address has an unconfirmed account, a new link is on its way.');
      toast.success('Check your inbox');
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : 'The link could not be sent. Try again shortly.';
      setError(message);
      toast.error(message);
    } finally {
      setSubmitting(false);
    }
  }

  if (sent) {
    return (
      <section className="iso-auth-success">
        <CheckCircle2 aria-hidden="true" />
        <h2>Check your inbox</h2>
        <p>{sent}</p>
      </section>
    );
  }

  return (
    <form onSubmit={onSubmit} className="iso-auth-form">
      <label className="iso-auth-field" htmlFor="resend-email">
        <span>Business email</span>
        <div>
          <Mail aria-hidden="true" />
          <input
            id="resend-email"
            type="email"
            required
            autoComplete="email"
            placeholder="name@company.com"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </div>
      </label>
      {error ? <p className="iso-auth-error" role="alert">{error}</p> : null}
      <button type="submit" disabled={!email.includes('@') || submitting} className="iso-auth-submit">
        {submitting ? 'Sending...' : 'Send a new link'}
        {!submitting ? <ArrowRight aria-hidden="true" /> : null}
      </button>
    </form>
  );
}
