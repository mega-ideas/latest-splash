import type { ReactNode } from 'react';

import PaymentsTabs from '@/components/dashboard/PaymentsTabs';

/**
 * Payments shell — one tabbed home for the four payment flows
 * (New · Runs · Rate holds · History). Tabs are routes, not client state.
 */
export default function PaymentsLayout({ children }: { children: ReactNode }) {
  return (
    <div className="space-y-4">
      <PaymentsTabs />
      {children}
    </div>
  );
}
