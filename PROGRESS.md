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

Next: M1 contracts.

Known issues

- None.
