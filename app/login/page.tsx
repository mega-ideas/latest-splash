import type { Metadata } from 'next';

import AuthShell from '@/components/auth/AuthShell';
import LoginForm from '@/components/auth/LoginForm';
import { FALLBACK_CUSTOMER_EMAIL, FALLBACK_CUSTOMER_PASSWORD } from '@/lib/auth/customer-session';
import { zkLoginEnabled } from '@/lib/auth/zklogin';
import { brand } from '@/lib/brand';

export const metadata: Metadata = {
  title: `Sign in — ${brand.name}`,
  description: 'Sign in to operate payouts, treasury, recipients and receipts.',
};

export const dynamic = 'force-dynamic';

export default function LoginPage() {
  const demo = process.env.NEXT_PUBLIC_DEMO_MODE === 'true'
    ? { email: process.env.CUSTOMER_EMAIL || FALLBACK_CUSTOMER_EMAIL, password: process.env.CUSTOMER_PASSWORD || FALLBACK_CUSTOMER_PASSWORD }
    : null;

  return (
    <AuthShell title="Welcome back." description="Sign in to operate payouts, treasury, recipients and receipts.">
      <LoginForm zkLogin={zkLoginEnabled()} demo={demo} />
    </AuthShell>
  );
}
