'use client';

import { useState, type FormEvent } from 'react';
import { ArrowRight, Eye, EyeOff, Lock } from 'lucide-react';
import { toast } from 'sonner';

/** Mirrors MIN_PASSWORD_LENGTH in lib/auth/password.ts; the server is the authority. */
const MIN_PASSWORD_LENGTH = 12;

type Props = {
  /** Route that takes `{ token, password }` and answers `{ email }` or `{ error, code }`. */
  endpoint: string;
  token: string;
  submitLabel: string;
  busyLabel: string;
  successToast: string;
  onDone: (email?: string) => void;
  /** The link is spent, expired or unknown: the page offers a new one. */
  onInvalidLink: () => void;
};

/**
 * The one form both delivered links land on: choose a password. It is the
 * only input, because the token in the URL already proves the mailbox, and
 * asking for the old password would defeat the point — the old password may
 * belong to whoever registered the address first.
 */
export default function PasswordFromLinkForm(props: Props) {
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const strong = password.length >= MIN_PASSWORD_LENGTH && /[A-Za-z]/.test(password) && /\d/.test(password);
  const canSubmit = strong && !submitting;

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    setError('');

    try {
      const response = await fetch(props.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: props.token, password }),
      });
      const body = (await response.json().catch(() => ({}))) as { email?: string; error?: string; code?: string };

      if (!response.ok) {
        if (body.code === 'invalid_token') {
          props.onInvalidLink();
          return;
        }
        throw new Error(body.error ?? 'That did not work. Check the password and try again.');
      }

      toast.success(props.successToast);
      props.onDone(body.email);
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : 'That did not work. Try again.';
      setError(message);
      toast.error(message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="iso-auth-form">
      <label className="iso-auth-field" htmlFor="link-password">
        <span>Choose a password</span>
        <div>
          <Lock aria-hidden="true" />
          <input
            id="link-password"
            type={showPassword ? 'text' : 'password'}
            required
            minLength={MIN_PASSWORD_LENGTH}
            autoComplete="new-password"
            placeholder={`${MIN_PASSWORD_LENGTH}+ characters with a letter and a number`}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
          <button
            type="button"
            className="iso-auth-reveal"
            onClick={() => setShowPassword((value) => !value)}
            aria-label={showPassword ? 'Hide password' : 'Show password'}
          >
            {showPassword ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
          </button>
        </div>
      </label>

      <div className="iso-password-strength" aria-label={strong ? 'Password meets the policy' : 'Password does not yet meet the policy'}>
        {[1, 2, 3].map((level) => (
          <span
            className={
              (level === 1 && password.length >= MIN_PASSWORD_LENGTH) ||
              (level === 2 && /[A-Za-z]/.test(password) && password.length > 0) ||
              (level === 3 && /\d/.test(password))
                ? 'is-active'
                : ''
            }
            key={level}
          />
        ))}
        <small>{strong ? 'Meets the policy' : `Use ${MIN_PASSWORD_LENGTH}+ characters with a letter and a number`}</small>
      </div>

      {error ? <p className="iso-auth-error" role="alert">{error}</p> : null}

      <button type="submit" disabled={!canSubmit} className="iso-auth-submit">
        {submitting ? props.busyLabel : props.submitLabel}
        {!submitting ? <ArrowRight aria-hidden="true" /> : null}
      </button>
    </form>
  );
}
