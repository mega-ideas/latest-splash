import { useCallback } from 'react'
import { useAccount, useSwitchChain, useWaitForTransactionReceipt, useWriteContract } from 'wagmi'
import { ARC_CHAIN_ID } from '@/lib/escrow'

/** One transaction lifecycle: wallet prompt, confirmation, result. Switches to Arc Testnet first. */
export function useEscrowWrite() {
  const { chainId, isConnected } = useAccount()
  const { switchChainAsync, isPending: isSwitching } = useSwitchChain()
  const { writeContractAsync, data: hash, isPending, error, reset } = useWriteContract()
  const receipt = useWaitForTransactionReceipt({ hash, chainId: ARC_CHAIN_ID })

  const wrongChain = isConnected && chainId !== ARC_CHAIN_ID

  const ensureChain = useCallback(async () => {
    if (chainId !== ARC_CHAIN_ID) await switchChainAsync({ chainId: ARC_CHAIN_ID })
  }, [chainId, switchChainAsync])

  const reverted = receipt.isSuccess && receipt.data.status === 'reverted'

  return {
    ensureChain,
    writeContractAsync,
    hash,
    wrongChain,
    isSwitching,
    isPending,
    isConfirming: receipt.isLoading,
    isSuccess: receipt.isSuccess && !reverted,
    reverted,
    error: error ?? receipt.error,
    reset,
  }
}
