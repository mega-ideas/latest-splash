# SplashProofEscrow

A USDC escrow contract for Arc Testnet. A payer locks USDC for a recipient, and the money is released when the beneficiary's VASP acknowledges the payment, either through an authenticated Chainlink CCIP message from another chain or directly on Arc. If no acknowledgement arrives before the expiry, anyone can return the full amount to the payer. A small capped fee is taken only when a payment is released.

Built with [Arc Studio](https://studio.arc.io)

## Screens

- **Pay**: allow USDC, then lock it in escrow with a recipient, beneficiary VASP, travel rule commitment, expiry and acknowledgement route.
- **Payments**: follow one payment on a timeline with links to the Arc explorer and the CCIP Explorer, and refund it after expiry.
- **Acknowledge**: the beneficiary VASP wallet confirms a local payment and releases the funds.

## Tech stack

- Solidity 0.8.28, Foundry
- OpenZeppelin Contracts, Chainlink CCIP contracts 2.0.0
- React, Vite, TypeScript, Tailwind CSS, wagmi, viem, ConnectKit
- Target network: Arc Testnet (chain ID 5042002), USDC with 6 decimals

## Development

Prerequisites: Foundry and Bun.

```
bun install
bun run dev
bun run contracts:build
bun run contracts:test
```

Contract source: `contracts/SplashProofEscrow.sol`. Tests: `contracts/test/`. Design notes: `docs/SplashProofEscrow-plan.md`.

### Environment variables

- `VITE_ESCROW_ADDRESS`: address of the deployed escrow contract. Without it the screens load but cannot send or read payments.
- `VITE_ESCROW_DEPLOY_BLOCK` (optional): block the escrow was deployed at. Without it, payment history only covers recent blocks.

### Foundry dependency

`lib/` is not committed. Before building or testing the contracts, run `forge install foundry-rs/forge-std --no-git` from this folder.
