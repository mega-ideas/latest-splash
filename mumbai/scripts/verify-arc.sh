#!/usr/bin/env bash
# Verify SplashProofEscrow on the Arc explorer.
#
#   ./scripts/verify-arc.sh 0x<escrow address>
#
# Only needed if Studio did not verify on deploy. It checks that first, so
# running it when it is unnecessary costs nothing.
#
# Judges open the explorer. Unverified, they see raw bytecode and have to take
# the fee claim on trust; verified, they read `settle` and see for themselves
# that the fee is charged in exactly one place.
set -euo pipefail

ADDR=${1:-}
if [ -z "$ADDR" ]; then
  echo "usage: $0 0x<escrow address>" >&2
  exit 1
fi

ARC_RPC=${ARC_RPC:-https://rpc.testnet.arc.io}
CHAIN_ID=5042002
EXPLORER=https://explorer.testnet.arc.io

ADMIN=0x7659A68c14b12DD619923181F07c44ceCE86df63
ROUTER=0xdE4E7FED43FAC37EB21aA0643d9852f75332eab8
FEE_RECIPIENT=0xB9c6d8844488cC8B8e671e2955AD811adC5DE60C
FEE_BPS=15

# Is there even a contract there?
CODE=$(cast code "$ADDR" --rpc-url "$ARC_RPC" 2>/dev/null || echo 0x)
if [ "$CODE" = "0x" ] || [ -z "$CODE" ]; then
  echo "No bytecode at $ADDR on Arc. Is the address right, and did the deploy land?" >&2
  exit 1
fi
echo "bytecode at $ADDR: ${#CODE} chars"

# Already verified? Blockscout answers without an API key.
ALREADY=$(curl -s --max-time 20 \
  "$EXPLORER/api?module=contract&action=getsourcecode&address=$ADDR" 2>/dev/null \
  | python3 -c 'import sys,json;d=json.load(sys.stdin);r=(d.get("result") or [{}])[0];print("yes" if r.get("SourceCode") else "no")' 2>/dev/null || echo unknown)
if [ "$ALREADY" = "yes" ]; then
  echo "Already verified. Nothing to do: $EXPLORER/address/$ADDR"
  exit 0
fi
echo "not yet verified, submitting source"

# The Foundry project Studio produced. Run from wherever src/ lives.
ROOT=$(cd "$(dirname "$0")/.." && pwd)
# Studio laid it out as arc/contracts/SplashProofEscrow.sol, not arc/src/.
for CANDIDATE in "$ROOT/arc" "$ROOT/arc/foundry" "$ROOT"; do
  for SUB in contracts src; do
    if [ -f "$CANDIDATE/$SUB/SplashProofEscrow.sol" ]; then
      PROJECT=$CANDIDATE; SRCPATH="$SUB/SplashProofEscrow.sol"; break 2
    fi
  done
done
if [ -z "${PROJECT:-}" ]; then
  echo "Cannot find src/SplashProofEscrow.sol. Pull Studio's push first, then rerun." >&2
  exit 1
fi
echo "project: $PROJECT"

# Constructor args must match the deploy exactly or the bytecode will not match.
ARGS=$(cast abi-encode "constructor(address,address,address,uint16)" \
  "$ADMIN" "$ROUTER" "$FEE_RECIPIENT" "$FEE_BPS")
echo "constructor args: $ARGS"

cd "$PROJECT"
forge verify-contract "$ADDR" "$SRCPATH:SplashProofEscrow" \
  --chain-id "$CHAIN_ID" \
  --verifier blockscout \
  --verifier-url "$EXPLORER/api/" \
  --constructor-args "$ARGS" \
  --watch

echo
echo "done: $EXPLORER/address/$ADDR"
