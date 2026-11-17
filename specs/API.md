# API specification (`apps/api`, Fastify 4)

Base path: `/api` (Nginx proxies `https://APP_DOMAIN/api/*` → `127.0.0.1:4000`). JSON only. Zod schemas live in `packages/shared/src/api.ts` and are shared with the web app.

Conventions
- Addresses lowercase in responses; accept any case.
- USD values as decimal strings with 2–18 decimals (never JS floats for money). Percentages as numbers with 2 decimals.
- Every on-chain value carries its source: `{ txHash, blockNumber, explorerUrl }`.
- Errors: `{ error: { code, message } }` with proper HTTP status. Messages say what went wrong and how to fix it.
- Rate limit: 120 req/min/IP for reads, 20 req/min for writes. CORS: `APP_DOMAIN` only.
- Cache: public GETs `Cache-Control: public, max-age=10` (stats/strategies), receipts that are terminal (`REVEALED`/`MISSED`) `max-age=3600`.

## Auth (SIWE, EIP-4361)
| Method | Path | Body | Result |
|---|---|---|---|
| GET | `/auth/nonce` | – | `{ nonce }` (single use, 10 min) |
| POST | `/auth/verify` | `{ message, signature }` | sets httpOnly `sid` cookie (Secure, SameSite=Lax, 7 days), `{ address }` |
| GET | `/auth/me` | – | `{ address } \| 401` |
| POST | `/auth/logout` | – | clears cookie |

SIWE message must have `domain = APP_DOMAIN`, `chainId = 4663`, `uri = https://APP_DOMAIN`.

## Public reads
| Method | Path | Notes |
|---|---|---|
| GET | `/stats` | `{ receiptsPrinted, strategiesLive, missedReveals, tvlUsd, updatedAt }` (GlobalStat) |
| GET | `/strategies` | query: `category=crypto\|stock\|ai\|all`, `sort=vs\|ret\|dd\|vaults`, `limit`, `cursor`. Each item: `id, slug, name, kind, category, template, market, assets, creator, ret30d, hold30d, vsHold, maxDrawdown30d, receipts, missed, followers, creatorShareBps, house` |
| GET | `/strategies/:idOrSlug` | full strategy + params + modelId/modelHash + registry tx |
| GET | `/strategies/:id/equity?range=30d` | `[{ at, equity, hold }]` for the chart |
| GET | `/strategies/:id/receipts?limit=&cursor=` | receipts newest first |
| GET | `/receipts/latest?limit=8` | for landing |
| GET | `/receipts/:idOrHash` | by `receiptNo`, commit hash, or `strategyId-nonce`. Returns commit, reveal, executions[], prices, `matchStatus`, `checks[]` (see below), AI artifact when revealed |
| GET | `/vaults/:owner` | indexed vault state + recent events (chain reads in the browser are the source of truth for balances) |
| GET | `/vaults/house` | public house vaults (address, strategy, nav, link) |
| GET | `/templates` | strategy templates with param schema (min/max/default) |
| GET | `/config/chain` | chain + tokens from `config/robinhood.json` (no secrets) |
| GET | `/health` | `{ ok, indexerLagBlocks, lastBlock, db, redis }` |

`checks[]` in a receipt response, in this order:
1. `commit_found` — block, hash
2. `reveal_matches` — recomputed `hashSignal` equals commit (or `missed`)
3. `executed_after_commit` — every execution L2 block > commit L2 block
4. `price_within_oracle` — each fill vs Chainlink price at that block, within the vault's slippage limit
5. `balance_changed_correctly` — amounts from the `Executed` events
Each: `{ id, ok, title, detail, txHash? }`.

## Writes (SIWE session required)
| Method | Path | Body | Notes |
|---|---|---|---|
| POST | `/backtest` | `{ template, params, assets }` | runs `packages/strategies` backtester on last 720 hourly candles; returns `{ ret, hold, maxDrawdown, winRate, trades, equity[] }`. Cached 10 min per input hash. |
| POST | `/strategies` | `{ name, template, params, assets, creatorShareBps }` | Validates and stores the metadata JSON. Returns `{ metadataURI, signer, revealWindow, modelHash }`. The browser then has the **user** sign `registerStrategy(signer, creatorShareBps, revealWindow, modelHash, metadataURI)`, so the user is the on-chain creator and `signer` is the platform signer that runs the template. The indexer links the on-chain strategy to this metadata via `metadataURI`. |
| PATCH | `/strategies/:id` | `{ name?, description? }` | only creator |
| POST | `/strategies/:id/deactivate` | – | returns the tx data for `setActive(false)`; the user signs it |

Rule: **anything that moves funds or changes on-chain state is signed by the user in the browser.** The API only stores metadata and serves data.

## WebSocket
`GET /ws` (upgrade). Client sends `{ "sub": "receipts" }` or `{ "sub": "strategy:<id>" }` or `{ "sub": "vault:<address>" }`. Server pushes `{ type: "receipt.committed" | "receipt.executed" | "receipt.revealed" | "receipt.missed" | "vault.event", data }`. Backed by Redis pub/sub from the worker.
