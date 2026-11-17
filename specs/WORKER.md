# Worker specification (`apps/worker`)

Node 20, TypeScript, viem for chain access, BullMQ queues on Redis, Prisma for Postgres. One PM2 process runs all job processors; each job type has its own queue and concurrency. Structured logs (pino). Never log keys, salts before reveal, or full prompts before reveal.

## Jobs

### 1. `indexer` (continuous)
- Streams: `registry`, `factory`, `vaults` (all vault addresses from `VaultCreated`).
- Poll `eth_getLogs` in chunks of ≤ 2,000 blocks from `IndexerCursor.lastBlock + 1` to `head − CONFIRMATIONS` (default 3).
- Reorg safety: store `lastBlockHash`; on mismatch, roll back events above the fork point and re-index.
- Handlers:
  - `StrategyRegistered` → upsert `Strategy` (merge metadata JSON from `metadataURI`).
  - `Committed` → `Commit{status: COMMITTED}` + Chainlink price snapshots for the strategy's assets at that block.
  - `Executed` (vault) → `Execution`, link to `Commit` by `(strategyId, nonce)`.
  - `Revealed` → fill signal fields + salt, `status: REVEALED`, then run the **match check**.
  - `Missed` → `status: MISSED`, increment counters.
  - Vault events → `VaultEvent` + update `Vault` row.
- Publish every change to Redis channel `events` for the API WebSocket.

**Match check** (after reveal): for each execution of that commit — same token pair and direction as the signal; `amountIn` value ≈ `sizeBps × vault allocation at execution` within ±2% tolerance (or the vault's daily-limit-capped amount). Result `MATCH`, `MISMATCH` (with `matchNote`), or `NO_EXECUTION`. Any `MISMATCH` raises a critical alert.

### 2. `prices` (every 60 s)
Read `latestRoundData` for every feed in config; insert `PricePoint` when `roundId` changes. Used by stats, paper performance and receipt checks.

### 3. `runner` (cron per strategy)
- Load active strategies run by our signers (house + template + AI).
- Fetch candles: crypto from a public exchange API; stocks from the market-data API (`MARKET_DATA_API_KEY`). Stocks only during US market hours.
- Call the template's pure function `decide(state, candles, params) → Signal | null`.
- AI template: build prompt from template + inputs (headlines, filings, prices); call `AI_BASE_URL` (OpenAI-compatible) with `AI_MODEL`; parse a strict JSON answer `{ action, asset, sizeBps, reason }`; `promptHash = keccak256(utf8(prompt + "\n" + JSON.stringify(inputs)))`; store `AiArtifact` (unpublished).
- If a signal is produced → enqueue `executor:commit`.

### 4. `executor` (queue, concurrency 1 per signer)
Pipeline per signal:
1. **Commit:** random 32-byte salt; `nonce = strategy.commitCount` (read from chain); `hash = registry.hashSignal(...)` (compute locally with the same encoding, assert equal to the view); store `SecretSalt` encrypted; send `commit`. Wait for receipt.
2. **Execute:** wait for the next L2 block. For each vault with `followingId == strategyId`, not paused, operator == our executor: compute `amountIn` from `sizeBps × allocation`, clamp to `remainingDailyUsd()` and pool liquidity; quote via QuoterV2; `minOutFromOperator = quote × (1 − 0.5%)`; send `executeSignal`. Skip vaults where a simulation (`eth_call`) reverts and log the reason (stale feed, limits, breaker). Batch with a nonce manager; do not block on a single vault.
3. **Reveal:** after all executions settle (or at `revealDeadline − 5 min` at the latest), send `reveal`. Publish the `AiArtifact` (set `publishedAt`).
- Retries with exponential backoff; gas bump on stuck tx. If reveal can't be sent 10 min before deadline → **critical alert**.

### 5. `missed` (every 5 min)
Find `COMMITTED` commits past their deadline (any strategy, not only ours) and send `markMissed`. This keeps the public record honest even for third-party strategies.

### 6. `stats` (every 5 min)
- Equity index per strategy: live vault fills where available, otherwise paper (Chainlink price at commit → next commit). Hold index for the strategy's market. Write `EquityPoint` (hourly granularity).
- 30-day return, vs-hold, max drawdown, followers, AUM → cached fields on `Strategy`.
- `GlobalStat`: receipts printed (commits), strategies live, missed reveals, TVL (sum of vault NAVs via `navLenient()` multicall).

### 7. `alerts`
Telegram bot (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`): low gas (< 0.002 ETH) on executor/signers, reveal deadline risk, mismatch detected, indexer lag > 2 min, tx failure rate > 10% in 15 min, breaker trips on house vaults.

## Keys and nonces
- Separate keys: `EXECUTOR_PRIVATE_KEY` (vault operator) and `SIGNER_PRIVATE_KEYS` (comma-separated, mapped to strategy IDs in DB). Each holds only gas.
- One nonce manager per key (Redis lock). Never send two txs from the same key concurrently without it.
- `SALT_ENCRYPTION_KEY` (32 bytes hex) for AES-256-GCM of salts and signals at rest.

## House strategies at launch
1. **Mag7 Rebalance** — equal weight AAPL, MSFT, NVDA, GOOGL, AMZN, META, TSLA; rebalance Mondays at US open when drift > 2%.
2. **SPY / QQQ Rotation** — hold the one with the stronger 20-day trend; check Friday close.
3. **News Desk (AI)** — NVDA, TSLA, COIN; hourly in market hours; commits `modelHash` and `promptHash`.
Each runs in a **public house vault funded with real USDG** (start small, e.g. $500 each). Addresses shown on the landing page.
