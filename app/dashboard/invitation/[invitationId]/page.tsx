import InvitationPage from '@/components/team/InvitationPage';

/**
 * Where the link in an invitation email opens. It sits under the dashboard, so a
 * signed-out visit is sent to sign in and brought back here (lib/approve/link.ts).
 * It shows the invitation only to the person it was sent to, and accepts nothing
 * by being opened. The id in the address grants nothing.
 */
export default async function Page({ params }: { params: Promise<{ invitationId: string }> }) {
  const { invitationId } = await params;
  let decoded = invitationId;
  try {
    decoded = decodeURIComponent(invitationId);
  } catch {
    /* an id that is not valid percent-encoding is asked for as it is, and the server answers not found */
  }
  return <InvitationPage invitationId={decoded} />;
}
