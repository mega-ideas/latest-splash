#!/usr/bin/env bash
# Watch a CCIP acknowledgement through to the escrow release, then anchor the
# commitment on Sui. Writes everything it learns to demo/settlement-A.json so
# the README proof table and the accountant CSV can be filled from one file.
#
#   ./scripts/watch-release.sh <messageId> <paymentRef> <commitment> <sepoliaTx>
set -uo pipefail

MSG=${1:?message id}
REF=${2:?payment ref}
COMMITMENT=${3:?commitment}
SRC_TX=${4:-}

ROOT=$(cd "$(dirname "$0")/.." && pwd)
ARC_RPC=${ARC_RPC:-https://rpc.testnet.arc.io}
ESCROW=${ESCROW:-0xc536d49c040c3327ee6aa72b83c8a9d31a72ae34}
# Released(bytes32,bytes32,address,uint256,uint256,bytes32,bytes32)
RELEASED_TOPIC=$(cast keccak "Released(bytes32,bytes32,address,uint256,uint256,bytes32,bytes32)")

echo "message  $MSG"
echo "ref      $REF"
echo "explorer https://ccip.chain.link/msg/$MSG"

STATE=""
DEADLINE=$(( $(date +%s) + 1800 ))
while [ "$(date +%s)" -lt "$DEADLINE" ]; do
  BODY=$(curl -s --max-time 25 "https://api.ccip.chain.link/v2/messages/$MSG" 2>/dev/null || echo '')
  NEW=$(printf '%s' "$BODY" | python3 -c 'import sys,json
try: print(json.load(sys.stdin).get("status",""))
except Exception: print("")' 2>/dev/null)
  if [ -n "$NEW" ] && [ "$NEW" != "$STATE" ]; then
    STATE=$NEW
    echo "$(date +%H:%M:%S)  ccip: $STATE"
  fi
  case "$STATE" in
    SUCCESS|FINALIZED) break ;;
    FAILED|FAILURE)    echo "CCIP reports failure; stopping." >&2; exit 1 ;;
  esac
  sleep 20
done

echo
echo "=== did the escrow release? ==="
RELEASED=""
for i in $(seq 1 10); do
  LOGS=$(cast logs --from-block $(( $(cast block-number --rpc-url "$ARC_RPC" 2>/dev/null || echo 71095257) - 5000 )) \
    --address "$ESCROW" "$RELEASED_TOPIC" "$REF" --rpc-url "$ARC_RPC" --json 2>/dev/null)
  if printf '%s' "$LOGS" | grep -q transactionHash; then
    RELEASED=$(printf '%s' "$LOGS" | python3 -c 'import sys,json
d=json.load(sys.stdin)
print(d[0]["transactionHash"] if d else "")' 2>/dev/null)
    [ -n "$RELEASED" ] && break
  fi
  sleep 15
done

if [ -n "$RELEASED" ]; then
  echo "Released on Arc: $RELEASED"
  echo "https://explorer.testnet.arc.io/tx/$RELEASED"
else
  echo "No Released event found yet. Check AckRejected on the escrow." >&2
fi

echo
echo "=== anchor the commitment on Sui ==="
cd "$ROOT"
npm run anchor --silent -- --commitment "$COMMITMENT" --message-id "$MSG" --src-tx "$SRC_TX" --execute 2>&1 | tail -4

python3 - "$MSG" "$REF" "$COMMITMENT" "$SRC_TX" "$RELEASED" <<'PY'
import json, sys, pathlib
msg, ref, commitment, srctx, released = sys.argv[1:6]
p = pathlib.Path('demo/payment-A.json')
d = json.loads(p.read_text()) if p.exists() else {}
d['settlement'] = {
    'ccipMessageId': msg, 'paymentRef': ref, 'sepoliaAckTx': srctx,
    'arcReleaseTx': released, 'feeMinor': '100000',
}
p.write_text(json.dumps(d, indent=2))
print(f'\nwritten demo/payment-A.json')
PY
