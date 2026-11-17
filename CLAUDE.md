# CLAUDE.md — rules for working in this repo

Project: **Receipts** — verifiable copy-trading on Robinhood Chain. Read `HANDOFF.md` first, then the file in `specs/` for the part you are touching.

## Ground rules

- The prototype `prototype/receipts.html` is the design source of truth. Match it; don't redesign.
- Every number shown to users must come from the indexer/API or a chain read. No hard-coded stats, no fake data outside tests and seed scripts.
- Anything that moves funds or changes on-chain state is signed by the user in the browser. The API never holds user keys.
- Never commit secrets. Never log private keys, salts before reveal, or AI prompts before reveal.
- Never market rule-based strategies as "AI".
- Contracts: no proxies, no admin power over existing vaults or user funds. Keep the NOUNY MIT notice in forked files.
- Don't deploy contracts to mainnet or move real funds without the owner's explicit go-ahead. Everything else: decide and proceed.

## Stack

pnpm workspaces + Turborepo · Next.js 14 (App Router) + Tailwind + wagmi v2 + viem + RainbowKit + TanStack Query · Fastify 4 + zod · Prisma + PostgreSQL 16 · Redis 7 + BullMQ · Foundry (Solidity 0.8.26, OZ 5) · PM2 + Nginx on Hostinger VPS.

## Commands

```bash
docker compose -f deploy/docker-compose.dev.yml up -d   # postgres, redis, anvil fork (chain 4663)
pnpm install
pnpm prisma migrate dev
pnpm dev                     # web :3000, api :4000, worker
pnpm test                    # vitest across packages
pnpm lint && pnpm typecheck
cd packages/contracts && forge build && forge test -vvv
forge test --fork-url $RPC_URL --match-path test/fork/*
forge coverage
```

## Conventions

- TypeScript strict, no `any`. Shared types and zod schemas in `packages/shared`.
- Money: bigint on chain, `Decimal`/string in DB and API; never JS floats for amounts.
- Addresses: lowercase in DB; checksum in UI.
- ABIs are generated from Foundry output into `packages/shared/abi` (`pnpm abi:gen`), never hand-written.
- Tests: contracts (Foundry unit/fuzz/invariant/fork), strategies (vitest, deterministic fixtures), API (vitest + supertest/inject), web (Playwright happy path on the anvil fork).
- After each milestone: all tests green, update `PROGRESS.md` (what's done, what's next, known issues), commit with a clear message.

## Where things are

| Need                              | File                                                        |
| --------------------------------- | ----------------------------------------------------------- |
| Product, architecture, milestones | `HANDOFF.md`                                                |
| Contract behaviour + invariants   | `specs/CONTRACTS.md`, `specs/contracts/*.sol`               |
| DB                                | `specs/schema.prisma` → copy to `prisma/schema.prisma`      |
| API                               | `specs/API.md`                                              |
| Worker jobs                       | `specs/WORKER.md`                                           |
| UI tokens/components              | `specs/DESIGN.md`                                           |
| Chain addresses                   | `config/robinhood.json` (re-verify on-chain before mainnet) |
| Deploy                            | `deploy/DEPLOY.md`                                          |
| Reference code                    | `reference/nouny-agent/` (MIT)                              |
