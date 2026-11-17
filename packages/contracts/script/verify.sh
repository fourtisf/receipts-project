#!/usr/bin/env bash
# Verifies SignalRegistry and VaultFactory on Robinhood Chain Blockscout using deployments/<chainId>.json.
# Vaults are created by the factory from the same bytecode, so Blockscout matches them automatically
# (similar-contract match); `pnpm verify-deployment` lets anyone check bytecode against this repo.
#
#   cd packages/contracts && ./script/verify.sh            # chain 4663 by default
set -euo pipefail
cd "$(dirname "$0")/.."

CHAIN_ID="${CHAIN_ID:-4663}"
VERIFIER_URL="${BLOCKSCOUT_API_URL:-https://robinhoodchain.blockscout.com/api/}"
FILE="deployments/${CHAIN_ID}.json"
[ -f "$FILE" ] || { echo "Missing $FILE — run script/Deploy.s.sol first"; exit 1; }

j() { python3 -c "import json,sys; d=json.load(open('$FILE')); v=d['$1']; print(','.join(map(str,v)) if isinstance(v,list) else v)"; }

REGISTRY=$(j registry)
FACTORY=$(j factory)
ARGS=$(cast abi-encode \
  "constructor(address,address,address,address,uint16,uint256,address,address[],address[],uint32[],uint24[])" \
  "$(j router)" "$REGISTRY" "$(j base)" "$(j treasury)" "$(j protocolCutBps)" "$(j maxDailyLimitUsd)" \
  "$(j defaultOperator)" "[$(j tokens)]" "[$(j feeds)]" "[$(j staleness)]" "[$(j feeTiers)]")

echo "→ SignalRegistry $REGISTRY"
forge verify-contract "$REGISTRY" src/SignalRegistry.sol:SignalRegistry \
  --verifier blockscout --verifier-url "$VERIFIER_URL" --chain-id "$CHAIN_ID" --watch

echo "→ VaultFactory $FACTORY"
forge verify-contract "$FACTORY" src/VaultFactory.sol:VaultFactory \
  --verifier blockscout --verifier-url "$VERIFIER_URL" --chain-id "$CHAIN_ID" \
  --constructor-args "$ARGS" --watch

echo "✓ Submitted. Check https://robinhoodchain.blockscout.com/address/$REGISTRY and /address/$FACTORY"
