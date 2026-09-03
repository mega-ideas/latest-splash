import type { ReactNode } from 'react';

import '@/styles/legacy.css';

/** Legacy stylesheet for this route tree only. */
export default function Layout({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
