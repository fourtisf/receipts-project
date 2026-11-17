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

## M3 — Web (read-only) ✅

Done
- Landing (`/`): nav, hero with live stats, product preview (browser frame + floating vault card + receipt), built-on, features, how-it-works (steps highlight receipt lines), security list + worst-case calculator, comparison, FAQ, final CTA, footer with contract addresses from `/config/chain` and "Not investment advice". ISR every 10 s.
- App: `/app` strategies (KPIs, category segmented control, sort, table → cards < 800 px), `/app/s/[id]` (KPIs, SVG equity chart vs hold, recent receipt slips, copy panel, on-chain facts with Blockscout links), `/app/s/[id]/receipt/[nonce]` permalink (full slip + stamp + checks + executions), `/app/verify` (API fast path, says so), `/app/vault` (connected wallet's vault or empty state, house vaults). Sidebar with live block; mobile top bar.
- wagmi v2 + RainbowKit with the Robinhood Chain object from `/config/chain` (connect only; injected wallets when no WalletConnect id). Live updates over `/api/ws`. OG images for landing, strategy, receipt.
- No fake data: every number from the API or a chain read; honest empty states. `scripts/seed-dev.ts` (DEV ONLY) seeds a local DB for visual work.
- **Acceptance**: Playwright screenshots vs the prototype at 1360 px and 390 px match section-for-section (differences only where real data differs); no horizontal scroll at 360 / 390 / 1360 px. Lighthouse (production build) landing: **98 performance / 96 accessibility** mobile, 100 / 96 desktop (the only a11y finding is the prototype's own `faint` grey contrast, kept as designed). `pnpm --filter web lint/typecheck/build` clean; Playwright smoke 16/16 (desktop + mobile).
- API: client IP from the local Nginx hop only (`TRUST_PROXY=loopback`, not spoofable); Next.js SSR on loopback is exempt from the per-IP rate limit.

## M4 — Web (write) ✅

Done
- SIWE sign-in (RainbowKit authentication adapter → `/api/auth/*`, "no gas"), session-aware wallet button.
- Vault: create (limits + asset chips), dashboard from chain reads (Multicall3): NAV, holdings, status, daily-limit meter, drawdown vs peak, worst case for the user's own limits; deposit (approve + deposit), withdraw per token (never disabled; "Max" keeps back a pending creator fee), follow / switch / stop / allocation, limits, pause / resume, revoke / restore bot, reset peak / marks; activity log; review changes handled (`TokenHeld`, `FeeUnpaid` decoded with amounts).
- Copy panel on strategy pages; US stock-token notice + geoblock via `/api/geo`.
- `/app/create`: template params from `/templates`, debounced backtest preview, `POST /strategies`, user signs `registerStrategy`, link once indexed.
- Client-side receipt verification (verify page + permalink): `commitOf`, `Revealed` log → `hashSignal` recomputed in the browser, genuine-vault `Executed` logs (later block, min-out, pair/direction); states the source and falls back to the API.
- Toasts, plain-language error decoding, `/docs` (commit-reveal, threat model, worst-case math, fees, verify-it-yourself), `/terms` + `/privacy` (templates marked for legal review), browser error reporting (`NEXT_PUBLIC_SENTRY_DSN`).
- API: SIWE (`/auth/nonce|verify|me|session|logout`), `POST /backtest`, `POST /strategies`, `PATCH /strategies/:id`, `POST /strategies/:id/deactivate`, `GET /geo` — 24 API tests.
- **Acceptance**: `pnpm --filter web e2e:fork` — on a fresh anvil fork, a fresh wallet connects, signs in, creates a vault, deposits, copies a strategy, pauses, revokes the bot and **withdraws successfully while paused and revoked** (on-chain asserts: `paused`, `operator == 0`, exact USDG back). Passed in my own run (157 s). Smoke e2e 24/24; lint / typecheck / build clean.

## M5 — Worker (runner / executor / revealer) ✅

Done
- `packages/strategies`: 7 rule-based templates + AI news helpers, backtester (720 h, 0.1 % cost, no look-ahead), market data (Coinbase / Binance / Polygon / Alpaca, Chainlink fallback) — 18 tests.
- Worker pipeline: runner (public paper portfolio, schedules, NYSE hours, committed-model check for AI), executor (encrypted salt stored before commit, local vs on-chain `hashSignal`, per-vault sizing + simulation, back-to-back executions, reveal with deadline alerts, crash recovery), missed-marker for any strategy, Telegram alerts + health checks — 23 worker tests.
- House strategies: `scripts/register-house.ts` (dry run by default).
- **Acceptance (compressed)**: `scripts/soak-fork.ts` on the fork — 15–28 signals per run, **0 missed reveals, 0 executions outside their commit window, 0 mismatches**, a forced crash between commit and reveal recovered and revealed. The 48 h soak must run on the deployed stack (needs keys + funded gas); CI runs a 3-min soak when `RPC_URL` is set.

## M6 — Deploy readiness ✅ (mainnet deploy waits for the owner)

Done
- `deploy/`: PM2 (`ecosystem.config.cjs`), Nginx, `deploy.sh`, `env.example` (every variable documented, REQUIRED marked), `DEPLOY.md` rewritten for this codebase (contracts from a local machine → server → app → Nginx/SSL → house strategies → monitoring → launch order).
- `pnpm check-config` (all 13 tokens, feeds, pools verified against chain state), `pnpm verify-deployment` (bytecode vs repo), `packages/contracts/script/Deploy.s.sol` + `script/verify.sh` (Blockscout).
- Independent adversarial review of the contracts; all High / Medium findings fixed (SECURITY.md §4).
- Monitoring: Sentry reporting (api / worker / web), `/api/health` for uptime, Telegram alerts.
- `LAUNCH_CHECKLIST.md`: status of HANDOFF §11 — remaining items need the owner (mainnet deploy, funding house vaults, legal review, monitoring accounts).

Known issues / notes
- The free public RPC (robinhood.drpc.org) rate-limits and only serves very recent state; use a paid archive RPC for production, CI fork tests and the 48 h soak.
- Backtests need exchange / market-data APIs reachable from the server (blocked in this build sandbox; the API falls back to Chainlink rounds and says so).
- Lighthouse accessibility 96: the prototype's light grey (`faint`) fails contrast; kept as designed pending your call.
