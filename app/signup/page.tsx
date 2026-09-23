'use client';

import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { ArrowRight, Building2, CheckCircle2, Eye, EyeOff, Globe2, Lock, Mail } from 'lucide-react';
import { toast } from 'sonner';

import IsometricAuthShell from '@/components/auth/IsometricAuthShell';

export default function SignUpPage() {
  const [sent, setSent] = useState(false);
  const [company, setCompany] = useState('');
  const [email, setEmail] = useState('');
  const [region, setRegion] = useState('Singapore');
  const [password, setPassword] = useState('');
  const [accepted, setAccepted] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  // Mirrors lib/auth/password.ts: twelve characters, a letter, a digit. The
  // server is the authority; this only stops a form the server would refuse.
  const strength = [password.length >= 12, /[A-Za-z]/.test(password), /\d/.test(password)].filter(Boolean).length;
  const canSubmit = company.trim().length > 1 && email.includes('@') && strength === 3 && accepted && !submitting;

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    setError('');

    try {
      const response = await fetch('/api/auth/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ company, email, region, password, accepted }),
      });
      const body = await response.json().catch(() => ({})) as { error?: string };

      if (!response.ok) {
        throw new Error(body.error ?? 'Unable to create the workspace. Review the details and try again.');
      }

      toast.success('Check your inbox to confirm the address');
      setSent(true);
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : 'Unable to create the workspace. Review the details and try again.';
      setError(message);
      toast.error(message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <IsometricAuthShell
      eyebrow="Open a business account"
      title="Build your payment desk."
      description="Create your workspace, then complete KYB to activate global settlement."
      art="/isometric/splash-finance.svg"
      artAlt="Splash Finance isometric typography"
      visualTitle="One operating layer"
      visualCopy="Move USD, settle globally, and retain every proof."
    >
      {sent ? (
        <section className="iso-auth-success">
          <CheckCircle2 aria-hidden="true" />
          <h2>Confirm your email</h2>
          <p>
            We sent a link to <strong>{email.trim().toLowerCase()}</strong>. Open it within 30 minutes to confirm the
            address and finish creating the account. Nothing can be done with the account until then.
          </p>
          <Link href="/verify-email">Did not get it? Send a new link</Link>
        </section>
      ) : (
      <form onSubmit={onSubmit} className="iso-auth-form">
        <div className="iso-auth-field-grid">
          <label className="iso-auth-field" htmlFor="signup-company">
            <span>Company name</span>
            <div>
              <Building2 aria-hidden="true" />
              <input
                id="signup-company"
                required
                autoComplete="organization"
                placeholder="Acme Logistics"
                value={company}
                onChange={(event) => setCompany(event.target.value)}
              />
            </div>
          </label>

          <label className="iso-auth-field" htmlFor="signup-region">
            <span>Primary market</span>
            <div>
              <Globe2 aria-hidden="true" />
              <select id="signup-region" value={region} onChange={(event) => setRegion(event.target.value)}>
                <option>Singapore</option>
                <option>Malaysia</option>
                <option>Indonesia</option>
                <option>Philippines</option>
                <option>Thailand</option>
                <option>Vietnam</option>
                <option>United Kingdom</option>
                <option>European Union</option>
              </select>
            </div>
          </label>
        </div>

        <label className="iso-auth-field" htmlFor="signup-email">
          <span>Business email</span>
          <div>
            <Mail aria-hidden="true" />
            <input
              id="signup-email"
              type="email"
              required
              autoComplete="email"
              placeholder="finance@company.com"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </div>
        </label>

        <label className="iso-auth-field" htmlFor="signup-password">
          <span>Create password</span>
          <div>
            <Lock aria-hidden="true" />
            <input
              id="signup-password"
              type={showPassword ? 'text' : 'password'}
              required
              autoComplete="new-password"
              placeholder="12+ characters with a letter and a number"
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

        <div className="iso-password-strength" aria-label={`Password strength ${strength} of 3`}>
          {[1, 2, 3].map((level) => <span className={strength >= level ? 'is-active' : ''} key={level} />)}
          <small>{strength === 3 ? 'Meets the policy' : 'Use 12+ characters with a letter and a number'}</small>
        </div>

        <label className="iso-auth-consent">
          <input type="checkbox" checked={accepted} onChange={(event) => setAccepted(event.target.checked)} />
          <span>I agree to the Splash terms and confirm I am authorized to register this business.</span>
        </label>

        {error ? <p className="iso-auth-error" role="alert">{error}</p> : null}

        <button type="submit" disabled={!canSubmit} className="iso-auth-submit">
          {submitting ? 'Creating workspace...' : 'Create business workspace'}
          {!submitting ? <ArrowRight aria-hidden="true" /> : null}
        </button>
      </form>
      )}

      <div className="iso-auth-next">
        <strong>What happens next?</strong>
        <span>1. Confirm your email</span>
        <span>2. Complete KYB</span>
        <span>3. Activate corridors</span>
      </div>

      <p className="iso-auth-switch">
        Already have an account? <Link href="/login">Sign in</Link>
      </p>
    </IsometricAuthShell>
  );
}
