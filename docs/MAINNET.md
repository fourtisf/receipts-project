# Mainnet deploy runbook (Robinhood Chain, chain 4663)

Owner decisions (recorded): **protocol cut 10 % (1000 bps)**, **beta cap $2,000 per vault per day**, **treasury and factory admin = the deployer wallet for now** (move to a Safe later; see the end). Run everything on **your own computer**, never on the server. Your private key never leaves your machine.

Pre-flight already done from the build environment (no key used):
- `pnpm check-config` against live mainnet: all 13 tokens, feeds and pools match (106 checks). Shallow pools: SPY ≈ 13.4k USDG, COIN ≈ 12.6k USDG → keep trades small.
- Deploy simulated against live mainnet state: **≈ 8.88M gas ≈ 0.00036 ETH** at 0.04 gwei.

Status: the contracts have had an internal review and an independent adversarial review (SECURITY.md §4), **not an external audit**. The $2,000/day cap bounds the risk per vault; raise it only with a new factory after an audit.

---

## 0. Requirements
- Foundry: `curl -L https://foundry.paradigm.xyz | bash` then `foundryup`
- Node 20 + pnpm (`corepack enable`), git, python3

## 1. Get the code
```bash
git clone -b claude/new-session-m6lqpp https://github.com/fourtisf/receipts-project.git
cd receipts-project
git submodule update --init --recursive
pnpm install
```

## 2. Create the bot keys (executor + signer)
```bash
cast wallet new      # → executor: save the private key in your password manager, note the address
cast wallet new      # → signer:   same
```
The executor address becomes the default operator of new vaults. Both private keys go only into the server `.env` (`EXECUTOR_PRIVATE_KEY`, `SIGNER_PRIVATE_KEYS`), never into chat or git.

## 3. Put the deployer key into an encrypted keystore (not on the command line)
```bash
cast wallet import deployer --interactive    # paste the deployer private key once, choose a password
cast wallet address --account deployer       # prints the deployer address
```

## 4. Fund on Robinhood Chain
- deployer: ≥ 0.002 ETH (deploy ≈ 0.00036 ETH)
- executor: 0.01 ETH · signer: 0.01 ETH (gas for commits, executions, reveals; alerts fire below 0.002)

## 5. Final checks
```bash
pnpm check-config
```
```bash
cd packages/contracts && forge test
```

## 6. Dry run (simulation, sends nothing)
```bash
export RPC_URL=https://robinhood.drpc.org
export DEPLOYER=$(cast wallet address --account deployer)
export TREASURY_ADDRESS=$DEPLOYER
export EXECUTOR_ADDRESS=0x...            # the executor address from step 2
export PROTOCOL_CUT_BPS=1000
export MAX_DAILY_LIMIT_USD=2000
```
```bash
forge script script/Deploy.s.sol --rpc-url "$RPC_URL" --account deployer --sender "$DEPLOYER"
```
Check the printed addresses and "Estimated amount required".

## 7. Deploy (real transactions)
```bash
forge script script/Deploy.s.sol --rpc-url "$RPC_URL" --account deployer --sender "$DEPLOYER" --broadcast
```
This writes `packages/contracts/deployments/4663.json` (registry, factory, start block, constructor args).

## 8. Verify
```bash
./script/verify.sh
```
```bash
cd ../.. && RPC_URL=https://robinhood.drpc.org pnpm verify-deployment
```

## 9. Hand back
```bash
git add packages/contracts/deployments/4663.json && git commit -m "Mainnet deployment" && git push
```
(or send the contents of `deployments/4663.json` — the addresses are public). Then the app `.env` gets `REGISTRY_ADDRESS`, `FACTORY_ADDRESS`, `START_BLOCK` (+ `NEXT_PUBLIC_*` copies) and the VPS deploy continues per `deploy/DEPLOY.md`.

---

## Later: move treasury and admin to a Safe multisig
```bash
cast send <FACTORY> "setTreasury(address)" <SAFE> --account deployer --rpc-url "$RPC_URL"
cast send <FACTORY> "transferAdmin(address)" <SAFE> --account deployer --rpc-url "$RPC_URL"
```
Then the Safe calls `acceptAdmin()`. Both only affect vaults created afterwards: each vault's treasury is immutable, so vaults created before the change keep paying the protocol cut to the deployer address. Moving early (before public launch) avoids that.
