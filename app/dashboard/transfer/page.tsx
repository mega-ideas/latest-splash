import TransferFlow from '@/components/transfer/TransferFlow';

/**
 * Transfer (v2 brief 5.4): Transfer and Send USDC are one flow. Five steps:
 * who you are paying, their details, the amount and where it is paid from,
 * review and approval, and the receipt. The flow is components/transfer/.
 */
export default function TransferPage() {
  return <TransferFlow />;
}
