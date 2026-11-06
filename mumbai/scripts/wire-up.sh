#!/usr/bin/env bash
# Everything between "Studio deployed the escrow" and "the demo is ready".
#
#   ./scripts/wire-up.sh 0x<escrow address on Arc>
#
# 1. deploy SplashTravelRuleAck on Sepolia, pointed at the escrow
# 2. allowlist the beneficiary on the sender
# 3. setAckSender on the escrow, so it accepts that sender from Sepolia
# 4. print the exact commands for the two demo payments
#
# Dry by default; pass --execute to send transactions.
set -euo pipefail

ESCROW=${1:-}
EXECUTE=${2:-}
if [ -z "$ESCROW" ]; then
  echo "usage: $0 0x<escrow address> [--execute]" >&2
  exit 1
fi

ROOT=$(cd "$(dirname "$0")/.." && pwd)
# shellcheck disable=SC1091
set -a; . "$ROOT/.env.wallets"; set +a

ARC_RPC=${ARC_RPC:-https://rpc.testnet.arc.io}
SEPOLIA_RPC=${SEPOLIA_RPC:-https://ethereum-sepolia-rpc.publicnode.com}

SEPOLIA_ROUTER=0x0BF3dE8c5D3e8A2B34D2BEeB17ABfCeBaf363A59
SEPOLIA_SELECTOR=16015286601757825753
ARC_SELECTOR=3034092155422581607
# Arc drops or strands writes below 20 gwei.
ARC_GAS="--gas-price 20gwei"

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }

say "0. the escrow"
# The Arc public RPC rate-limits; an empty answer usually means 429, not "no
# contract". Retry before concluding anything.
CODE=0x
for i in 1 2 3 4 5; do
  CODE=$(cast code "$ESCROW" --rpc-url "$ARC_RPC" 2>/dev/null || echo 0x)
  [ "$CODE" != "0x" ] && [ -n "$CODE" ] && break
  sleep 3
done
[ "$CODE" = "0x" ] || [ -z "$CODE" ] && { echo "no bytecode at $ESCROW on Arc after 5 tries" >&2; exit 1; }
echo "   $ESCROW  (${#CODE} chars of bytecode)"
OWNER=$(cast call "$ESCROW" 'owner()' --rpc-url "$ARC_RPC" 2>/dev/null | sed 's/^0x000000000000000000000000/0x/')
echo "   owner: $OWNER"
if [ "$(echo "$OWNER" | tr 'A-Z' 'a-z')" != "$(echo "$ADMIN_ADDRESS" | tr 'A-Z' 'a-z')" ]; then
  echo "   REFUSING: the escrow owner is not our admin, so setAckSender would fail." >&2
  exit 1
fi

if [ "$EXECUTE" != "--execute" ]; then
  say "DRY RUN — rerun with --execute to send transactions."
  echo "   would deploy SplashTravelRuleAck on Sepolia -> receiver $ESCROW"
  echo "   would setVasp($BENEFICIARY_ADDRESS, true) on the sender"
  echo "   would setAckSender($SEPOLIA_SELECTOR, <sender>) on the escrow"
  exit 0
fi

say "1. deploy SplashTravelRuleAck on Sepolia"
cd "$ROOT/evm/sepolia"
OUT=$(forge create src/SplashTravelRuleAck.sol:SplashTravelRuleAck \
  --rpc-url "$SEPOLIA_RPC" --private-key "$BENEFICIARY_PK" --broadcast \
  --constructor-args "$SEPOLIA_ROUTER" "$ARC_SELECTOR" "$ESCROW" "$ADMIN_ADDRESS" 2>&1)
echo "$OUT" | tail -5
SENDER=$(echo "$OUT" | grep -iE 'Deployed to:' | awk '{print $NF}')
[ -z "$SENDER" ] && { echo "could not parse the deployed address" >&2; exit 1; }
echo "   sender: $SENDER"

say "2. allowlist the beneficiary on the sender"
# The sender's admin is ADMIN_ADDRESS, so that key signs.
cast send "$SENDER" 'setVasp(address,bool)' "$BENEFICIARY_ADDRESS" true \
  --rpc-url "$SEPOLIA_RPC" --private-key "$ADMIN_PK" 2>&1 | grep -E 'status|transactionHash' | head -2

say "3. point the escrow at the sender"
cast send "$ESCROW" 'setAckSender(uint64,address)' "$SEPOLIA_SELECTOR" "$SENDER" \
  --rpc-url "$ARC_RPC" --private-key "$ADMIN_PK" $ARC_GAS 2>&1 | grep -E 'status|transactionHash' | head -2

say "wired. the loop is closed:"
echo "   Sepolia sender  $SENDER"
echo "   Arc escrow      $ESCROW"
echo "   beneficiary     $BENEFICIARY_ADDRESS (allowlisted)"

cat <<EOF

Next, the two demo payments. Payment A releases; Payment B expires and refunds.

  # A: 10 USDC, expiry +6h, remote acknowledgement over CCIP
  cast send $ESCROW 'open(bytes32,address,address,uint256,uint256,bytes32,uint64,bool)' \\
    \$(cast keccak "SPL-MUM-A-0001") $BENEFICIARY_ADDRESS $BENEFICIARY_ADDRESS \\
    10000000 100000 <COMMITMENT_A> \$(( \$(date +%s) + 21600 )) true \\
    --rpc-url $ARC_RPC --private-key \$PAYER_PK $ARC_GAS

  # B: 2 USDC, expiry +10m, so it can be refunded on camera
  cast send $ESCROW 'open(bytes32,address,address,uint256,uint256,bytes32,uint64,bool)' \\
    \$(cast keccak "SPL-MUM-B-0002") $BENEFICIARY_ADDRESS $BENEFICIARY_ADDRESS \\
    2000000 20000 <COMMITMENT_B> \$(( \$(date +%s) + 600 )) false \\
    --rpc-url $ARC_RPC --private-key \$PAYER_PK $ARC_GAS

The payer must approve the escrow for USDC first:

  cast send 0x3600000000000000000000000000000000000000 'approve(address,uint256)' \\
    $ESCROW 12000000 --rpc-url $ARC_RPC --private-key \$PAYER_PK $ARC_GAS

Then acknowledge A, which sends the real CCIP message:

  ACK_SENDER=$SENDER PK=\$BENEFICIARY_PK npm run ack -- --payment A --execute
EOF
