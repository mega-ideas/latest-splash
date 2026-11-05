import { redirect } from 'next/navigation';

/**
 * Where every governance alert sends an owner (lib/server/governance-events.ts
 * REVIEW_PATH): "Review spending rules and allowances". Rules are given,
 * changed and taken back in Settings, so the link lands on Team & rules there.
 */
export default function SpendingRulesPage() {
  redirect('/dashboard/settings#rules');
}
