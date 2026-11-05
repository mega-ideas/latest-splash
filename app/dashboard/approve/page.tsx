import ApproveInbox from '@/components/approve/ApproveInbox';

/**
 * Approve (v2 brief 5.10): what waits for this person's passkey. The wallet
 * requests are read by `/api/wallet/signing-requests`, which takes the person
 * and their business from the session.
 */
export default function Page() {
  return <ApproveInbox />;
}
