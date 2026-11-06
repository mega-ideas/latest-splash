# SplashProofEscrow: build plan (nothing written or deployed yet)

Target: Arc Testnet (5042002), CCIP router `0xdE4E7FED43FAC37EB21aA0643d9852f75332eab8`, USDC ERC-20 `0x3600000000000000000000000000000000000000`.

## Checked just now
- Router answers `typeAndVersion() = "Router 1.2.0"` on Arc Testnet.
- USDC at `0x3600...0000` answers `decimals() = 6`.
- `@chainlink/contracts-ccip@2.0.0` exists on npm. Its `CCIPReceiver` imports `@openzeppelin/contracts@5.3.0/...` (an aliased copy), so the build needs one extra remapping next to the project's OpenZeppelin 5.6.1. Its constructor reverts on a zero router, `ccipReceive` is `onlyRouter`, and it adds a default `getCCVsAndFinalityConfig` (default CCV, wait for finality) that I leave untouched.
- Library is 2.0.0 and the live router is 1.2.0. `ccipReceive(Any2EVMMessage)` is the same entry point, but pranked tests cannot prove the live router accepts this receiver, so the fork run checks `supportsInterface`.

## Files
- `contracts/SplashProofEscrow.sol`
- `contracts/test/SplashProofEscrow.t.sol`, `contracts/test/mocks/MockUSDC.sol` (blocklist-capable, 6 decimals), invariant handler
- `package.json` + `remappings.txt`: add `@chainlink/contracts-ccip@2.0.0`, map `@chainlink/contracts-ccip/` and `@openzeppelin/contracts@5.3.0/`

## State machine
`None -> Open -> Released | Refunded` (terminal, no way back).
Per payment: payer (msg.sender of `open`), recipient, beneficiaryVasp, amount, maxFee, commitment, expiry, remoteAck, status.
Time rule: settle only when `block.timestamp < expiry`, refund only when `>= expiry`. They never overlap, so an ack and a refund cannot both succeed.

## Behaviour
- `open`: validations as specified, `transferFrom` via SafeERC20 after state is written (CEI), `nonReentrant`.
- `_ccipReceive`:
  1. Revert only if `sourceChainSelector` has no configured ack sender, `sender` is not a 32-byte address encoding, or the decoded address differs from the configured one (an unset sender of `address(0)` never matches).
  2. Decode `(paymentRef, vasp, commitment, ackHash)`.
  3. Not Open / expired / not `remoteAck` / vasp mismatch / commitment mismatch: emit `AckRejected(paymentRef, messageId, reason)` and return.
  4. Otherwise settle with the real `messageId`.
- `ackLocal`: only `beneficiaryVasp`, only if `!remoteAck`, same checks, then settle with `messageId = 0`. Failures revert with custom errors (the caller is a normal transaction, so a revert is the clearest answer).
- `settle`: `fee = min(maxFee, amount * feeBps / 10000)`, status = Released first, then net to recipient and fee to feeRecipient, emit `Released(paymentRef, messageId, recipient, net, fee, ackHash, commitment)`. The fee exists nowhere else.
- `refund`: anyone, only at or after expiry, only if Open; status = Refunded first, full amount to payer, no fee, emit `Refunded`. Not pausable, no admin involvement.
- Admin: `setAckSender(uint64,address)`, `setFeeRecipient(address)`, both emit events. No upgrade proxy, no pause, no sweep, no function that touches escrowed principal. `feeBps` is immutable (<= 100).

## Reject reasons (`AckRejected`)
NotOpen (covers unknown and duplicate delivery), Expired, NotRemoteAck, VaspMismatch, CommitmentMismatch, Malformed (data is not exactly 4 words), TransferFailed (see question 2).

## Tests (Foundry)
1. Pranked-router happy path: payment released, net + fee correct, events match.
2. Wrong source chain and wrong sender revert (also unset sender and malformed sender bytes).
3. Late ack after expiry: no revert, `AckRejected(Expired)`, then `refund` returns the full amount.
4. Duplicate delivery: second message emits `AckRejected(NotOpen)`, balances unchanged.
5. Vasp mismatch and commitment mismatch: `AckRejected`, payment stays Open.
6. Local path: right vasp settles, wrong caller, `remoteAck` payment, expired, mismatch all revert; remote path rejects `!remoteAck` payments.
7. Fee fuzz: `fee <= maxFee`, `fee <= amount * feeBps / 10000`, `net + fee == amount`, `feeBps` 0 to 100.
8. Blocklisted recipient `0x70997970C51812dc3A010C7d01b50e0d17dc79C8`: behaviour per question 2, then refund works after expiry.
9. Invariant: USDC balance of the escrow equals the sum of Open amounts, driven by a handler that opens, acks (remote and local), refunds and warps time. Direct donations are excluded from the handler because they would break strict equality by design.
10. Admin: events, access control, `feeBps > 100` constructor revert, zero-address checks.

## Pipeline after the code is written
Balanced security review (two independent reviewers) with fix loop, static analysis, the tests above, then a fork rehearsal of the deployment. Everything stops there until you approve a deployment.

## Questions open (see chat)
