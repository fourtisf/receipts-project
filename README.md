# Receipts

Verifiable copy-trading on **Robinhood Chain** (chain ID 4663). Every trade decision is committed on-chain
before it executes and revealed afterwards; users copy strategies into their own non-custodial vault.

> Working name. The product name and domain come from `APP_NAME` / `APP_DOMAIN` in `.env` — never hard-coded.

- Product, architecture, milestones: [`HANDOFF.md`](HANDOFF.md)
- Working rules for contributors and agents: [`CLAUDE.md`](CLAUDE.md)
- Specs: [`specs/`](specs) · Design reference: [`prototype/receipts.html`](prototype/receipts.html)
- Progress: [`PROGRESS.md`](PROGRESS.md) · Decisions: [`DECISIONS.md`](DECISIONS.md) · Security: [`SECURITY.md`](SECURITY.md)
- Deploy: [`deploy/DEPLOY.md`](deploy/DEPLOY.md)

## Layout

```
apps/web        Next.js 14 (App Router, Tailwind, wagmi v2, RainbowKit)
apps/api        Fastify 4 REST + WebSocket
apps/worker     indexer · prices · runner · executor · revealer · missed · stats · alerts
packages/contracts   Foundry (SignalRegistry, ReceiptsVault, VaultFactory)
packages/shared      chain config, receipt hashing, zod API schemas, generated ABIs
packages/strategies  pure strategy templates + backtester
packages/db          Prisma client + Decimal helpers
prisma/         schema + migrations
config/         robinhood.json (tokens, feeds, pools)
deploy/         PM2, Nginx, env example, deploy script, docker-compose (dev)
```

## Develop

Requirements: Node 20, pnpm 10 (`corepack enable`), Foundry, Docker (or local Postgres 16 + Redis 7).

```bash
docker compose -f deploy/docker-compose.dev.yml up -d   # postgres, redis, anvil fork of chain 4663
cp deploy/env.example .env                               # then set DATABASE_URL etc. for local dev
pnpm install
pnpm prisma migrate dev
pnpm dev                                                 # web :3000, api :4000, worker
```

Checks:

```bash
pnpm lint && pnpm typecheck && pnpm test
cd packages/contracts && forge test -vvv
forge test --match-path 'test/fork/*' --fork-url $RPC_URL
```

## Deployed contracts

Not deployed yet. Addresses will be listed here (and in the site footer) once verified on Blockscout.

## License

MIT. `ReceiptsVault` and `VaultFactory` derive from NOUNY's `AgentVault` (MIT) — see
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).
