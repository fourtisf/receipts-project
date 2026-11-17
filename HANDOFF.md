# Receipts — Production Handoff

> Working name: **Receipts**. Final name and domain are not decided yet. Never hard-code either: use `APP_NAME` and `APP_DOMAIN` from env.
>
> Approved UI: `prototype/receipts.html`. Open it in a browser. It is the pixel reference for every screen. Demo data inside it must be replaced by real data from the API.

---

## 1. What we are building

Receipts is a **copy-trading platform on Robinhood Chain whose track records cannot be faked.**

- **Strategies** (rule-based or AI) trade crypto and Robinhood Stock Tokens against USDG.
- Every trade decision is **committed on-chain before it executes** (a hash), then **revealed** after execution. Nobody can add winners or delete losers later. A commit that is never revealed is publicly counted as a **missed reveal**.
- Users copy a strategy into **their own vault contract**. The executor bot can only swap inside the vault within limits the user sets. Only the user's wallet can withdraw.
- Creators earn **only from profit above the vault's previous high** (high-water mark). If the user loses, nobody gets paid.

### Why (positioning)

Competing "AI agent" platforms on Robinhood Chain (e.g. nounyagent.com) show leaderboards from their own database, have closed bots, unverified contracts and near-zero real usage. Crypto Twitter calls that a LARP. Receipts' whole brand is: **every claim is checkable on-chain.** Every engineering decision must protect that:

1. Contracts verified on Blockscout on deploy day.
2. Contracts **and** worker/bot code in a public repo (keys and API secrets excluded).
3. All stats on the site are computed from chain events (indexer), never typed in.
4. House strategies trade real money from day one, publicly.
5. No "AI" claims for rule-based strategies. AI strategies commit model + prompt hash.
6. No token in v1.

---

## 2. Users and core flows

| Actor              | What they do                                                                                                          |
| ------------------ | --------------------------------------------------------------------------------------------------------------------- |
| Visitor            | Reads landing page, opens app, browses strategies, checks receipts. No wallet needed.                                 |
| Follower           | Connects wallet (SIWE), creates vault, deposits USDG, copies a strategy, sets limits, pauses, revokes bot, withdraws. |
| Creator            | Connects wallet, creates a strategy from a template (or AI template), earns a share of followers' profit.             |
| Executor (our bot) | Runs strategies, commits signals, executes swaps in follower vaults, reveals.                                         |
| Anyone             | Verifies any receipt by number or commit hash; calls `markMissed` on expired commits.                                 |

### Flow A — receipt lifecycle (the core loop)

1. Strategy runner computes a signal for strategy `S`: `{tokenIn, tokenOut, sizeBps, promptHash}`.
2. Signer for `S` calls `SignalRegistry.commit(S, hash)` where
   `hash = keccak256(abi.encode(chainId, registry, S, nonce, signal, salt))`, `nonce = strategy.commitCount` (sequential per strategy), `salt` = 32 random bytes stored encrypted in DB.
3. In a **later L2 block**, executor calls `vault.executeSignal(nonce, tokenIn, tokenOut, amountIn, minOut)` for every vault following `S` (respecting each vault's limits).
4. After executions (and before `revealDeadline`), signer calls `SignalRegistry.reveal(S, nonce, signal, salt)`. Contract recomputes and stores the hash match.
5. If not revealed by the deadline, anyone calls `markMissed(S, nonce)` → `strategy.missed++` forever.
6. Indexer joins Committed → Executed(vaults) → Revealed into one **Receipt** and checks execution matches the revealed signal (token pair and direction). Mismatch is flagged publicly on the receipt.

### Flow B — paper strategies

Strategies with zero followers still commit and reveal. Their performance is computed from the Chainlink price at commit block vs. at the next signal. This lets anyone build a verifiable track record without capital.

### Flow C — vault

Create vault (one per wallet) → set limits (daily limit, max slippage, drawdown breaker, allowed assets) → deposit USDG → follow strategy with allocation cap → bot trades → withdraw any time (works when paused, works without our website).

---

## 3. Architecture

```
                ┌──────────────┐        ┌────────────────────────┐
  Browser ─────▶│ apps/web     │──REST─▶│ apps/api (Fastify)     │──┐
  (wagmi/viem)  │ Next.js 14   │◀──WS───│ REST + WebSocket       │  │
       │        └──────────────┘        └────────────────────────┘  │
       │ tx (user signs)                          ▲                  │ Prisma
       ▼                                          │ Redis pub/sub    ▼
 ┌───────────────────────────┐      ┌────────────────────────┐  ┌──────────┐
 │ Robinhood Chain (4663)    │◀─tx──│ apps/worker            │─▶│ Postgres │
 │ SignalRegistry            │      │ indexer · runner ·     │  └──────────┘
 │ VaultFactory → Vault[]    │─evt─▶│ executor · revealer ·  │  ┌──────────┐
 │ Uniswap V3 · Chainlink    │      │ missed-marker · prices │─▶│ Redis    │
 └───────────────────────────┘      └────────────────────────┘  └──────────┘
```

### Monorepo (pnpm workspaces + Turborepo)

```
receipts/
├─ apps/
│  ├─ web/        Next.js 14 App Router, Tailwind, wagmi v2, viem, RainbowKit, TanStack Query
│  ├─ api/        Fastify 4, zod, Prisma client, SIWE auth, WebSocket (@fastify/websocket)
│  └─ worker/     Node 20 workers (BullMQ on Redis): indexer, runner, executor, revealer, missed, prices
├─ packages/
│  ├─ contracts/  Foundry: src/, test/, script/  (Solidity 0.8.26, OpenZeppelin 5.x)
│  ├─ shared/     types, zod schemas, ABIs (generated), chain config, receipt hashing helpers
│  └─ strategies/ pure TS strategy templates (deterministic, unit-tested)
├─ prisma/        schema.prisma + migrations   (see specs/schema.prisma)
├─ config/        robinhood.json (tokens, feeds, pools — see §6)
├─ deploy/        PM2, Nginx, deploy script, env example
└─ prototype/     receipts.html (design reference, not shipped)
```

Stack is fixed (matches all other production projects): **Next.js 14, Fastify, Prisma, PostgreSQL 16, Redis 7, Node 20, PM2 + Nginx on a Hostinger VPS.**

---

## 4. Smart contracts (summary — full spec in `specs/CONTRACTS.md`)

| Contract         | Role                                                                                                                                                                                             |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `SignalRegistry` | Strategies, commits, reveals, missed reveals. One per deployment.                                                                                                                                |
| `ReceiptsVault`  | One per user. Holds funds. Operator may only `executeSignal` within limits and only for a live commit of the strategy the owner follows. Drawdown breaker, allocation cap, high-water-mark fees. |
| `VaultFactory`   | Creates one vault per wallet with a token/feed/pool list fixed at factory deploy. Admin can only rotate the default operator for **new** vaults.                                                 |

Base: fork `AgentVault` + `AgentVaultFactory` from github.com/nounyagent/nouny-agent (MIT — **keep their copyright notice** in the forked files and in `THIRD_PARTY_NOTICES.md`). Copies are in `reference/nouny-agent/`. Their protections are good (oracle-computed min-out, pinned pool per token, daily cap, balance-before/after, approval reset); we extend them.

Interfaces to implement exactly: `specs/contracts/*.sol`.

**Guarded launch:** `VaultFactory` has an immutable `MAX_DAILY_LIMIT_USD` (beta: $2,000). Vaults cannot set a daily limit above it. Raise only by deploying a new factory after an external audit.

---

## 5. Backend

### 5.1 Database

Prisma schema in `specs/schema.prisma`. Core tables: `Strategy`, `Commit` (the receipt), `Execution`, `Vault`, `VaultEvent`, `PricePoint`, `EquityPoint`, `User`, `Session`, `IndexerCursor`, `SecretSalt`.

### 5.2 API

Full spec in `specs/API.md`. Public read endpoints need no auth. Writes need SIWE session. All responses validated with zod schemas from `packages/shared`.

### 5.3 Worker

Full spec in `specs/WORKER.md`. Jobs: `indexer` (events → DB, reorg-safe with N confirmations), `prices` (Chainlink snapshots), `runner` (strategy signals on schedule), `executor` (commit → execute in vaults → reveal), `missed` (markMissed on expired commits), `stats` (equity curves, KPIs).

### 5.4 Keys

- `EXECUTOR_PRIVATE_KEY` — the vault operator. Holds only gas ETH.
- `SIGNER_PRIVATE_KEY_<n>` — one signer per house/template strategy group. Holds only gas ETH.
- `DEPLOYER_PRIVATE_KEY` — used only for deploy scripts, never on the server.
- Keys are never logged, never sent to the browser, never committed. Low-balance alert when < 0.002 ETH.

---

## 6. Chain config

`config/robinhood.json` holds Robinhood Chain (chain ID **4663**, explorer robinhoodchain.blockscout.com, public RPC robinhood.drpc.org), Uniswap V3 SwapRouter02, and 13 tokens (USDG, WETH, cbBTC, AAPL, NVDA, TSLA, MSFT, AMZN, GOOGL, META, SPY, QQQ, COIN) with Chainlink feeds, staleness limits and pinned pool fee tiers. It was taken from the MIT-licensed NOUNY repo. **Before mainnet deploy, re-verify every address on-chain** with a `scripts/check-config.ts` (feed answers > 0, decimals, description matches, pool exists at fee tier with liquidity). Use a paid RPC (dRPC/Alchemy key) in production, the public one only for dev.

Stock tokens: Chainlink stock feeds pause on weekends; vault swaps in stock tokens must revert while stale (by design). Robinhood Stock Tokens are not available to US persons — show a notice and geoblock stock-token copy flows for US IPs (configurable `GEOBLOCK_STOCKS=US`).

Development: run `anvil --fork-url $RPC_URL --chain-id 4663` and deploy contracts to the fork so real Uniswap pools and Chainlink feeds are used.

---

## 7. Frontend

Pixel reference: `prototype/receipts.html` (landing at `#/`, app at `#/app`). Design tokens in `specs/DESIGN.md`. Port faithfully to React + Tailwind; do not redesign.

### Routes

| Route                         | Screen (prototype section)                                                                                                       | Data                                                            |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `/`                           | Landing                                                                                                                          | `GET /stats`, `GET /strategies?limit=5`, `GET /receipts/latest` |
| `/app`                        | Strategies table + KPIs                                                                                                          | `GET /strategies`                                               |
| `/app/s/[id]`                 | Strategy detail: KPIs, equity chart vs hold, recent receipts, copy panel, on-chain facts                                         | `GET /strategies/:id`, `/equity`, `/receipts`                   |
| `/app/vault`                  | Create vault / vault dashboard                                                                                                   | chain reads (viem) + `GET /vaults/:owner`                       |
| `/app/verify`                 | Check a receipt                                                                                                                  | `GET /receipts/:idOrHash`                                       |
| `/app/create`                 | **New:** create strategy from template (not in prototype — build in the same style: form card left, live backtest preview right) | `GET /templates`, `POST /backtest`, `POST /strategies`          |
| `/app/s/[id]/receipt/[nonce]` | Receipt permalink (shareable, OG image)                                                                                          | `GET /receipts/:id`                                             |

### Wallet + auth

- wagmi v2 + viem + RainbowKit, custom chain object for Robinhood Chain from `config/robinhood.json`; auto-add network on connect.
- SIWE (EIP-4361) → httpOnly secure cookie session (7 days). Sign-in costs no gas.
- All vault actions are user-signed transactions from the browser (create, deposit/approve, follow, setLimits, pause, setOperator(0), withdraw). The API never holds user keys.

### Must-haves

- Every number links to its source (tx on Blockscout).
- Receipt verification runs **client-side from chain data** (viem reads + recompute hash), with the API as a fast path. The page says which source it used.
- Remove all "Demo data" badges once data is real.
- Responsive to 360px, keyboard focus visible, `prefers-reduced-motion` respected.
- OG images for landing, strategy and receipt pages (`@vercel/og` or satori).

---

## 8. Strategy templates (v1)

All long-only, against USDG. Implemented as pure functions in `packages/strategies` with unit tests and a backtester (720 hourly candles, 0.1% cost per trade, compared to buy-and-hold).

| Template                             | Params                                                                                                                                               |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Momentum (breakout + trailing stop)  | window 6–168h, trailing stop 1–30%, size 10–100%                                                                                                     |
| Mean reversion                       | MA window 10–200h, entry 0.5–4σ, stop 1–50%, size                                                                                                    |
| MA crossover                         | fast 2–100h, slow 5–400h, stop, take profit, size                                                                                                    |
| RSI reversal                         | period 5–50, buy < 5–45, sell > 55–95, stop, size                                                                                                    |
| Buy the dip in uptrend               | trend 48–400h, dip window 10–100h, depth 0.5–4σ, trailing stop, size                                                                                 |
| Equal-weight rebalance (house: Mag7) | assets, schedule (weekly), drift threshold                                                                                                           |
| Trend rotation (house: SPY/QQQ)      | assets, lookback 5–60d, schedule                                                                                                                     |
| AI news (house: News Desk)           | assets, model (OpenAI-compatible endpoint), prompt template; commits `modelHash` + `promptHash`; full prompt + inputs stored and published at reveal |

Market data for indicators: crypto from a public exchange API (e.g. Coinbase/Binance klines); stocks from a market-data API (Polygon.io or Alpaca, key in env). Execution and performance prices always come from chain (pool fills + Chainlink).

---

## 9. Milestones and acceptance criteria

Work through these in order. After each milestone: run all tests, update `PROGRESS.md`, commit.

**M0 — Scaffold.** Monorepo, pnpm, Turborepo, ESLint/Prettier, TS strict, Prisma, docker-compose (Postgres + Redis + anvil fork), GitHub Actions (lint, typecheck, test, forge test).
✅ `pnpm dev` runs web + api + worker against local services.

**M1 — Contracts.** `SignalRegistry`, `ReceiptsVault`, `VaultFactory` per `specs/CONTRACTS.md`. Foundry unit + fuzz + invariant tests + fork tests on Robinhood Chain (real pools, feeds). Deploy script + Blockscout verification script.
✅ All invariants in CONTRACTS.md §5 have a test. ≥ 95% line coverage on src. Slither has no high/medium findings left unexplained.

**M2 — Indexer + API (read).** Event indexing with reorg safety, receipts assembly, price snapshots, equity + KPIs, all public GET endpoints, WebSocket `receipts` channel.
✅ On the anvil fork, a scripted commit → execute → reveal shows up as one receipt via `GET /receipts/:id` within 10 s.

**M3 — Web (read).** Landing + app read-only screens matching the prototype, wired to the API.
✅ Visual diff vs prototype is close at 1360px and 390px. Lighthouse ≥ 90 performance/accessibility on landing.

**M4 — Web (write).** SIWE, vault create/deposit/follow/limits/pause/revoke/withdraw, create-strategy page with backtest preview, client-side receipt verification.
✅ Full happy path on the fork from a fresh wallet. Withdraw works while paused and with operator revoked.

**M5 — Worker (runner/executor/revealer).** Templates, house strategies, commit/execute/reveal pipeline, missed-marker, alerts (Telegram bot) for failures and low gas.
✅ 48 h soak on the fork: zero missed reveals for house strategies; every execution references a live commit; mismatch detector passes.

**M6 — Deploy + launch.** VPS setup per `deploy/DEPLOY.md`, mainnet contract deploy with beta caps, Blockscout verification, house vaults funded with real money (small), uptime + error monitoring (Sentry), public repo.
✅ Launch checklist (§11) fully ticked.

---

## 10. Security requirements

- Threat model: the executor key **will** be stolen one day. Worst case must stay `dailyLimit × (slippage + pool fee + oracle lag)` per vault per day, as shown in the UI calculator.
- No upgradeable proxies. No admin function that touches user funds or existing vaults.
- Reentrancy guards on every external state-changing vault function; CEI ordering.
- Oracle: reject answer ≤ 0, stale, or future-dated. Separate stricter staleness for swaps and fee settlement than for NAV breaker checks (CONTRACTS.md §3.4).
- API: rate limiting (`@fastify/rate-limit`), zod validation on all input, CORS locked to `APP_DOMAIN`, helmet headers, SIWE nonce single-use with 10-min expiry.
- Secrets only from env; `.env` never committed; `pnpm audit` in CI.
- Before raising beta caps: external audit by a recognised firm, public bug bounty.

---

## 11. Launch checklist (anti-LARP)

- [ ] All three contracts verified on Blockscout; addresses in README and footer.
- [ ] Public GitHub repo: contracts, worker, strategies, indexer (no secrets).
- [ ] `scripts/verify-deployment.ts`: anyone can compare deployed bytecode to the repo.
- [ ] House strategies (Mag7 Rebalance, SPY/QQQ Rotation) live with real funds in public vaults.
- [ ] Every stat on landing and app comes from the indexer; zero hard-coded numbers.
- [ ] Every receipt has a permalink and verifies client-side from chain.
- [ ] Docs page: how commit-reveal works, threat model, worst-case math, fees.
- [ ] Terms + privacy + "not investment advice" + US stock-token notice.
- [ ] Monitoring: Sentry, uptime check, Telegram alerts (missed reveal risk, low gas, indexer lag > 2 min).

---

## 12. Out of scope for v1

Token; bring-your-own-signer SDK for external creators (v2); BTC via Hyperliquid (v2); perps; multiple strategies per vault; mobile app.
