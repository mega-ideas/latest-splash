'use client';

import { useState, type FormEvent } from 'react';
import { ArrowRight, BadgeCheck, Mail } from 'lucide-react';

/**
 * "Join the waitlist" CTA for the landing page.
 *
 * The trigger is a real `.iso-button` in the correct ghost variant for its
 * surface, so it reads as a sibling of the other hero/CTA buttons (same
 * isometric extrusion, lift-on-hover, press-on-active). On click it expands in
 * place into a one-field email form built from the same isometric material —
 * the extruded field from the auth shell + a filled `.iso-button` submit.
 *
 * - `tone`: 'light' for the cream hero surface (dark-ink ghost), 'dark' for the
 *   deep final-CTA panel (light ghost). Matches whichever siblings sit beside it.
 * - `variant`: 'iso' (default) or 'mob' for the phone button system.
 */
type Tone = 'light' | 'dark';

export default function WaitlistCta({
  variant = 'iso',
  tone = 'light',
}: {
  variant?: 'iso' | 'mob';
  tone?: Tone;
}) {
  const [phase, setPhase] = useState<'idle' | 'open' | 'submitting' | 'done'>('idle');
  const [email, setEmail] = useState('');
  const [error, setError] = useState('');

  const triggerClass = variant === 'mob'
    ? 'mob-btn mob-btn-ghost'
    : `iso-button ${tone === 'dark' ? 'iso-button-dark-ghost' : 'iso-button-ghost'}`;
  const submitClass = variant === 'mob' ? 'mob-btn mob-btn-primary' : 'iso-button';

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (phase === 'submitting') return;
    setPhase('submitting');
    setError('');
    try {
      const response = await fetch('/api/waitlist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, source: `landing-${variant}` }),
      });
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) throw new Error(body.error ?? 'Something went sideways — try again.');
      setPhase('done');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Something went sideways — try again.');
      setPhase('open');
    }
  }

  if (phase === 'done') {
    return (
      <p className={`iso-waitlist-done${tone === 'dark' ? ' is-dark' : ''}`} role="status">
        <BadgeCheck aria-hidden="true" />
        You&apos;re on the list — we&apos;ll email you when your corridor opens.
      </p>
    );
  }

  if (phase === 'idle') {
    return (
      <button type="button" className={triggerClass} onClick={() => setPhase('open')}>
        Join the waitlist
      </button>
    );
  }

  return (
    <form className={`iso-waitlist-form${tone === 'dark' ? ' is-dark' : ''}`} onSubmit={onSubmit} aria-label="Join the waitlist">
      <span className="iso-waitlist-field">
        <Mail aria-hidden="true" />
        <input
          type="email"
          required
          autoFocus
          autoComplete="email"
          aria-label="Work email"
          placeholder="name@company.com"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          disabled={phase === 'submitting'}
        />
      </span>
      {/* Honeypot — humans never see it, bots fill it. */}
      <input type="text" name="company" tabIndex={-1} autoComplete="off" aria-hidden="true" className="iso-waitlist-trap" />
      <button type="submit" className={submitClass} disabled={phase === 'submitting'}>
        {phase === 'submitting' ? 'Joining…' : 'Join'}
        {phase !== 'submitting' ? <ArrowRight aria-hidden="true" /> : null}
      </button>
      {error ? <p className="iso-waitlist-error" role="alert">{error}</p> : null}
    </form>
  );
}
