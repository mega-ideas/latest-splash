#!/usr/bin/env bash
# cast send against Arc, with retries.
#
# Arc's public RPC rate-limits hard (HTTP 429), and it does so on the
# EIP-1559 fee-history lookup before the transaction is even built. A failed
# send here almost never means the call is wrong; it means we were throttled.
#
# Do not force --gas-price: a price below what Arc wants gets the transaction
# rejected outright. Arc priced our successful writes at ~32.5 gwei on its own.
#
#   ./scripts/arc-send.sh <private-key> <to> '<sig>' [args...]
set -uo pipefail

PK=${1:?private key}; TO=${2:?to}; SIG=${3:?signature}; shift 3
ARC_RPC=${ARC_RPC:-https://rpc.testnet.arc.io}

for attempt in 1 2 3 4 5 6 7 8; do
  OUT=$(cast send "$TO" "$SIG" "$@" --rpc-url "$ARC_RPC" --private-key "$PK" 2>&1)
  if printf '%s' "$OUT" | grep -q 'status  *1 (success)'; then
    printf '%s\n' "$OUT" | grep -E '^transactionHash|^blockNumber|^status' | head -3
    exit 0
  fi
  if printf '%s' "$OUT" | grep -qiE '429|rate limit'; then
    echo "  attempt $attempt: rate limited, backing off $((attempt * 5))s" >&2
    sleep $((attempt * 5))
    continue
  fi
  # A real failure: show it and stop rather than hammering a broken call.
  printf '%s\n' "$OUT" | head -12 >&2
  exit 1
done

echo "gave up after 8 attempts, still rate limited" >&2
exit 1
