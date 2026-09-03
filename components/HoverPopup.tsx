'use client';

import { useState } from 'react';
import { Info } from 'lucide-react';

interface HoverPopupProps {
  children: React.ReactNode;
  title: string;
  content: string;
  position?: 'top' | 'bottom' | 'left' | 'right';
}

export default function HoverPopup({ children, title, content, position = 'top' }: HoverPopupProps) {
  const [isVisible, setIsVisible] = useState(false);

  const positionClasses = {
    top: 'bottom-full mb-2 left-1/2 -translate-x-1/2',
    bottom: 'top-full mt-2 left-1/2 -translate-x-1/2',
    left: 'right-full mr-2 top-1/2 -translate-y-1/2',
    right: 'left-full ml-2 top-1/2 -translate-y-1/2',
  };

  return (
    <div
      className="relative block w-full"
      onMouseEnter={() => setIsVisible(true)}
      onMouseLeave={() => setIsVisible(false)}
    >
      {children}
      {isVisible && (
        <div className={`absolute z-50 w-64 rounded-xl border border-[#326273]/10 bg-white p-4 shadow-xl transition-opacity ${positionClasses[position]}`}>
          <div className="flex items-start gap-2">
            <Info className="mt-0.5 h-4 w-4 shrink-0 text-[var(--info)]" />
            <div>
              <div className="text-sm font-semibold text-[#326273]">{title}</div>
              <div className="mt-1 text-[13px] text-[#326273]/70">{content}</div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
