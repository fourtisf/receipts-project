# Progress

## M0 — Scaffold ✅

Done

- pnpm workspaces + Turborepo monorepo: `apps/{web,api,worker}`, `packages/{contracts,shared,strategies,db}`.
- TypeScript strict everywhere (`noUncheckedIndexedAccess`), ESLint 8 + Prettier, `no-explicit-any` as error.
- Prisma schema copied from `specs/schema.prisma`; initial migration `prisma/migrations/*_init`.
- `deploy/docker-compose.dev.yml` (Postgres 16, Redis 7, anvil fork of chain 4663).
- GitHub Actions: format, build, lint, typecheck, vitest (with Postgres + Redis services), web build, `pnpm audit`; Foundry fmt/build/test/fork (when `RPC_URL` secret is set)/snapshot/coverage; Slither (fail on medium+).
- Foundry project with forge-std + OpenZeppelin 5.4 submodules; spec interfaces in `packages/contracts/src/interfaces`.
- `pnpm dev` verified: web on :3000, API `/health` → `{ ok: true, db: true, redis: true }`, worker connects to Postgres + Redis.

## M1 — Contracts ✅

Done
- `SignalRegistry`, `ReceiptsVault` (fork of NOUNY AgentVault, MIT notice kept), `VaultFactory` (fork of AgentVaultFactory) implementing `specs/contracts/*.sol` exactly; `libraries/L2Block.sol` (ArbSys, NOUNY L-3 fix).
- 111 Foundry tests (unit + fuzz + invariant + gas) + 7 fork tests on Robinhood Chain — all green. Every invariant in CONTRACTS.md §5 has tests (mapping in SECURITY.md §2).
- Coverage on `src/`: 99.6 % lines, 98.3 % statements, 89.8 % branches, 100 % functions.
- Fork: full commit → execute → reveal → sell through the real Uniswap V3 pools and Chainlink feeds for WETH, cbBTC, NVDA, SPY (fills within ±0.4 % of oracle); config addresses checked on-chain; weekend-stale stock feed reverts while withdraw works.
- Gas: worst-case `executeSignal` with 13 tokens held ≈ 650k; `createVault` ≈ 3.4M. `.gas-snapshot` committed, checked in CI.
- Slither: 0 high / 0 medium; remaining lows explained in SECURITY.md §4.
- `script/Deploy.s.sol` (reads config, writes `deployments/<chainId>.json`), `script/verify.sh` (Blockscout). Deploy tested on the anvil fork.
- ABIs generated into `packages/shared/src/abi` (`pnpm abi:gen`); TS `hashSignal` verified against the Solidity vector.
- Bugs found and fixed by the tests: factory paging overflow; zero-output dust swaps.

Run
```bash
cd packages/contracts
forge test --no-match-path 'test/fork/*'                       # unit / fuzz / invariant / gas
anvil --fork-url $RPC_URL --chain-id 4663 &                     # or docker compose (deploy/)
forge test --match-path 'test/fork/*' --fork-url http://127.0.0.1:8545
FOUNDRY_PROFILE=coverage forge coverage --no-match-path 'test/fork/*' --no-match-coverage 'test|script' --report summary
```

## M2 — Indexer + read API ✅

Done
- Worker: reorg-safe indexer (`apps/worker/src/indexer`), chunked `eth_getLogs` to `head − CONFIRMATIONS`, idempotent upserts, rollback on hash mismatch; handlers for every registry / factory / vault event; Chainlink snapshots at each commit; match check after reveal (critical alert on mismatch); Redis pub/sub for the WebSocket.
- Jobs on BullMQ: `prices` (every 60 s), `stats` (every 5 min: equity curves, 30-day KPIs, followers, AUM, vault NAVs, GlobalStat).
- API: all public GET endpoints from API.md (`/stats`, `/strategies`, `/strategies/:idOrSlug`, `/equity`, `/receipts`, `/receipts/latest`, `/receipts/:idOrHash` with `checks[]`, `/vaults/:owner`, `/vaults/house`, `/templates`, `/config/chain`, `/metadata/:hash`, `/health`) + WebSocket `/ws` (receipts / strategy:<id> / vault:<address>). Every response validated with the shared zod schemas; cache headers per API.md.
- Template catalog with parameter ranges and validation (`packages/strategies/src/catalog.ts`).
- Tests: API 13 (seeded schema, `app.inject`), worker 15 (match check, equity model, reorg rollback), shared 6.
- **Acceptance**: `pnpm e2e:fork` deploys to the anvil fork, starts the real worker + API, sends commit → execute → reveal; the receipt was served by `GET /receipts/:id` as REVEALED / MATCH with all five checks ✓ **4.2 s after the commit was sent** (target ≤ 10 s).

Next: M3 web (read-only).

## Work in progress (committed ahead, accepted per milestone)

- M3 web (read-only) is being built in `apps/web` (not committed yet).
- M4 API side done: SIWE (`/auth/nonce|verify|me|logout`), `POST /backtest`, `POST /strategies`, `PATCH /strategies/:id`, `POST /strategies/:id/deactivate`, `GET /geo` — 24 API tests.
- M5 pipeline done: strategy templates + backtester + AI helpers (`packages/strategies`, 18 tests); worker runner / executor (commit → execute → reveal, crash recovery) / missed-marker / alerts (23 worker tests). Fork soak (`scripts/soak-fork.ts`): 0 missed reveals, 0 mismatches, crash recovered.
- M6 tooling: `pnpm check-config` (all 13 tokens verified on-chain via the fork), `pnpm verify-deployment`, `scripts/register-house.ts` (dry run by default), updated `deploy/env.example` and `deploy/DEPLOY.md`.

Known issues
- Public dRPC rate-limits (429). Use a local anvil fork (pinned block) for development; a paid RPC key for production / CI fork tests (`RPC_URL` secret).
