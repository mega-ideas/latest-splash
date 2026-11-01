'use client';

import TitleForm from '@/components/team/TitleForm';
import type { MembershipRole } from '@/lib/membership-roles';
import { memberTitle } from '@/lib/team/member-title';

/**
 * "Your title" in Settings, Team: every member, whatever their role, sets the title that shows after
 * their name (Aisha (CFO)). It changes only how the name is written, grants nothing, and is instant.
 * An old "Declined by" keeps the title it was made under.
 */
export default function OwnTitle({
  userId,
  title,
  role,
  financeLead,
  onChanged,
}: {
  userId: string;
  title: string | null;
  role: MembershipRole | null;
  financeLead: boolean;
  onChanged: () => void;
}) {
  // Without a title, this is what people read after the name.
  const without = memberTitle({ role, financeLead });
  return (
    <section aria-labelledby="own-title" className="space-y-2 rounded-xl bg-[#f4f8fa] p-3">
      <h3 id="own-title" className="text-[13px] font-extrabold text-[#0c3e48]">Your title</h3>
      <p className="text-[13px] leading-5 text-[#326273]">
        {title ? `You show as ${title} after your name.` : `You show as ${without} after your name until you set a title.`}
      </p>
      <TitleForm userId={userId} current={title} label="Job title" whose="Your" roleWord={without} autoComplete="organization-title" onChanged={onChanged} />
    </section>
  );
}
