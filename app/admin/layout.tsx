import type { ReactNode } from 'react';

import '@/styles/legacy.css';
import { Providers } from '@/app/providers';

export default function AdminRootLayout({ children }: { children: ReactNode }) {
  return <Providers>{children}</Providers>;
}
