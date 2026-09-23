'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useState, type ReactNode } from 'react';
import { ArrowRight, CheckCircle2 } from 'lucide-react';

import IsometricAuthShell from '@/components/auth/IsometricAuthShell';
import PasswordFromLinkForm from '@/components/auth/PasswordFromLinkForm';

/**
 * Where the reset link lands. Choose a new password; every earlier session
 * ends; sign in with the new one. A spent or expired link sends the reader
 * back to request another.
 */
export default function ResetPasswordPage() {
  return (
    <Suspense fallback={<Shell title="Reset your password." description="One moment." />}>
      <ResetPassword />
    </Suspense>
  );
}

function Shell(props: { title: string; description: string; children?: ReactNode }) {
  return (
    <IsometricAuthShell
      eyebrow="Account recovery"
      title={props.title}
      description={props.description}
      art="/isometric/treasury.svg"
      artAlt="Isometric smart treasury"
      visualTitle="Secure by default"
      visualCopy="A new password ends every session that was open before it."
    >
      {props.children}
      <p className="iso-auth-switch">
        Remembered it? <Link href="/login">Back to sign in</Link>
      </p>
    </IsometricAuthShell>
  );
}

type Stage = 'set' | 'done' | 'invalid';

function ResetPassword() {
  const params = useSearchParams();
  const token = params.get('token')?.trim() ?? '';
  const [stage, setStage] = useState<Stage>(token ? 'set' : 'invalid');

  if (stage === 'done') {
    return (
      <Shell title="Password updated." description="Every session that was signed in before now has ended.">
        <section className="iso-auth-success">
          <CheckCircle2 aria-hidden="true" />
          <h2>Sign in with your new password</h2>
          <p>Nothing else about the account changed.</p>
          <Link href="/login">
            Go to sign in <ArrowRight aria-hidden="true" />
          </Link>
        </section>
      </Shell>
    );
  }

  if (stage === 'set') {
    return (
      <Shell title="Reset your password." description="Choose a new password. The link proves the address is yours.">
        <PasswordFromLinkForm
          endpoint="/api/auth/reset-password"
          token={token}
          submitLabel="Set new password"
          busyLabel="Updating..."
          successToast="Password updated"
          onDone={() => setStage('done')}
          onInvalidLink={() => setStage('invalid')}
        />
      </Shell>
    );
  }

  return (
    <Shell
      title="That link has expired."
      description="Reset links work once and for 30 minutes. Request another and we will email it to you."
    >
      <div className="iso-auth-help">
        <strong>Request a new link</strong>
        <span>
          <Link href="/forgot-password">Go to password reset</Link>
        </span>
      </div>
    </Shell>
  );
}
