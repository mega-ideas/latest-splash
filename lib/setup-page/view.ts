/**
 * Account setup, worded (v2 brief 5.9). Which steps are done is the server's
 * fact (lib/server/onboarding.ts derives it from records on every read); this
 * says where the person is, what is next, what is waiting on someone else and
 * what comes after. Four steps are required; the fifth, a first recipient, is
 * optional and never counted. Pure and client-safe.
 */
import type { OnboardingState, OnboardingStep } from '../server/onboarding.ts';

export type SetupSummary = {
  requiredDone: number;
  requiredTotal: number;
  complete: boolean;
  /** The first required step still to do. A step waiting on someone else is not it. */
  next: OnboardingStep | null;
  headline: string;
  subline: string;
  progress: string;
  unlocks: string;
  /** What comes next once setup is complete. */
  after: Array<{ label: string; detail: string; href: string }>;
};

export function setupSummary(state: Pick<OnboardingState, 'steps' | 'complete'>): SetupSummary {
  const required = state.steps.slice(0, 4);
  const requiredDone = required.filter((s) => s.done).length;
  const complete = state.complete || required.every((s) => s.done);
  const next = complete ? null : required.find((s) => !s.done && !s.pending) ?? null;
  const waiting = !complete && next === null && required.some((s) => s.pending);
  const recipientDone = state.steps.find((s) => s.id === 'recipient')?.done === true;

  const after: SetupSummary['after'] = complete
    ? [
        { label: 'Create your business wallet', detail: 'Your owners sign for it; Splash holds no key.', href: '/dashboard/wallet' },
        ...(recipientDone ? [] : [{ label: 'Save your first recipient', detail: 'A supplier you will pay, checked before any payment.', href: '/dashboard/recipients' }]),
        { label: 'Give your team their rules', detail: 'What each person may pay on their own.', href: '/dashboard/settings#team' },
      ]
    : [];

  return {
    requiredDone,
    requiredTotal: required.length,
    complete,
    next,
    headline: complete ? 'Setup is complete' : waiting ? 'Waiting for verification' : 'Finish setting up this workspace',
    subline: complete
      ? 'Your workspace is ready. Here is what usually comes next.'
      : waiting
        ? 'Your business is in review. There is nothing for you to do until it finishes, and we will tell you.'
        : 'Four steps open payments for your business. A fifth, saving your first recipient, is optional.',
    progress: `${requiredDone} of ${required.length} required steps done`,
    unlocks: 'Payments unlock when verification is complete. Everything else here you can finish at your own pace.',
    after,
  };
}
