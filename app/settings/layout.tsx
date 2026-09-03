import type { ReactNode } from 'react';

import '@/styles/legacy.css';
import { Providers } from '@/app/providers';

/** Legacy stylesheet + toast/query providers for this route tree only. */
export default function Layout({ children }: { children: ReactNode }) {
  return <Providers>{children}</Providers>;
}
