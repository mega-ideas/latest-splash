#!/usr/bin/env bash
# Deploy both contracts on Whitechain the moment there is gas.
#
#   ./scripts/deploy-whitechain.sh            # check only
#   ./scripts/deploy-whitechain.sh --execute
#
# Faucet: https://faucet.testnet.whitechain.io  (NOT faucet.whitechain.io, which
# does not resolve). 0.5 WBT per 24 hours per address, so there is one shot.
#
# The invoice contract needs a token with EIP-3009. The official USDT
# 0xcedfB56113143d55b2358b8CFbB0dEB5Ad2f55a7 is a MAINNET address and has no
# code on testnet, so pass the testnet token with USDT_ADDRESS=0x… once the
# booth gives it. Without it only the registry deploys, which is still the
# piece that matters: it is where every Splash proof lands.
set -uo pipefail

EXECUTE=${1:-}
ROOT=$(cd "$(dirname "$0")/.." && pwd)
# shellcheck disable=SC1091
set -a; . "$ROOT/.env.wallets"; set +a

WC=${WHITECHAIN_RPC:-https://rpc.testnet.whitechain.io}
USDT=${USDT_ADDRESS:-}

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }

say "gas"
BAL=$(cast balance "$ADMIN_ADDRESS" --rpc-url "$WC" 2>/dev/null || echo 0)
echo "  admin $ADMIN_ADDRESS"
echo "  WBT   $BAL"
if [ "$BAL" = "0" ] || [ -z "$BAL" ]; then
  echo
  echo "  No WBT. Claim it at https://faucet.testnet.whitechain.io for the address above,"
  echo "  then rerun. Nothing can deploy without it."
  exit 1
fi

say "token"
if [ -n "$USDT" ]; then
  CODE=$(cast code "$USDT" --rpc-url "$WC" 2>/dev/null || echo 0x)
  if [ "$CODE" = "0x" ]; then
    echo "  No contract at $USDT on Whitechain testnet. Registry only."
    USDT=""
  else
    echo "  $USDT  ($(cast call "$USDT" 'symbol()(string)' --rpc-url "$WC" 2>/dev/null))"
  fi
else
  echo "  USDT_ADDRESS not set. Registry only."
  echo "  (The plan's 0xcedfB561… is mainnet; it has no code here.)"
fi

if [ "$EXECUTE" != "--execute" ]; then
  say "DRY RUN — rerun with --execute."
  exit 0
fi

cd "$ROOT/evm/whitechain"

say "deploy SplashProofRegistry"
OUT=$(forge create src/SplashProofRegistry.sol:SplashProofRegistry \
  --rpc-url "$WC" --private-key "$ADMIN_PK" --broadcast \
  --constructor-args "$ADMIN_ADDRESS" 2>&1)
echo "$OUT" | grep -E 'Deployed to|Transaction hash'
REG=$(echo "$OUT" | grep 'Deployed to:' | awk '{print $NF}')

if [ -n "$USDT" ]; then
  say "deploy SplashInvoice"
  OUT=$(forge create src/SplashInvoice.sol:SplashInvoice \
    --rpc-url "$WC" --private-key "$ADMIN_PK" --broadcast \
    --constructor-args "$USDT" "$ADMIN_ADDRESS" "$FEE_RECIPIENT_ADDRESS" 15 2>&1)
  echo "$OUT" | grep -E 'Deployed to|Transaction hash'
  INV=$(echo "$OUT" | grep 'Deployed to:' | awk '{print $NF}')
fi

say "allow the relayer to record"
cast send "$REG" 'setRecorder(address,bool)' "$ADMIN_ADDRESS" true \
  --rpc-url "$WC" --private-key "$ADMIN_PK" 2>&1 | grep -E '^status' | head -1

say "done"
echo "  registry $REG"
[ -n "${INV:-}" ] && echo "  invoice  $INV"
echo
echo "Now mirror the proofs onto Whitechain:"
echo "  REGISTRY=$REG WHITECHAIN_RPC=$WC npm run record -- --rail arc --execute"
