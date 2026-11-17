# Prompt for Claude Code

Copy everything below the line into Claude Code, opened in an empty folder that contains this handoff package.

---

You are the lead engineer building **Receipts**, a verifiable copy-trading platform on Robinhood Chain (chain ID 4663). Everything you need is in this folder.

**Read first, in this order:** `HANDOFF.md` → `CLAUDE.md` → `specs/CONTRACTS.md` → `specs/contracts/*.sol` → `specs/schema.prisma` → `specs/API.md` → `specs/WORKER.md` → `specs/DESIGN.md` → `deploy/DEPLOY.md`. Then open `prototype/receipts.html` in a browser (landing at `#/`, app at `#/app`). That file is the approved design; match it.

**Build it** as the pnpm + Turborepo monorepo described in HANDOFF §3, following milestones **M0 → M6** in HANDOFF §9, in order:

- M0 scaffold (monorepo, Prisma from `specs/schema.prisma`, docker-compose from `deploy/`, CI)
- M1 contracts in Foundry (fork `reference/nouny-agent/` per CONTRACTS.md, implement the three interfaces exactly, all invariants tested, fork tests against Robinhood Chain)
- M2 indexer + read API
- M3 web read-only, pixel-matched to the prototype
- M4 web writes (SIWE, vault flows, create strategy, client-side receipt verification)
- M5 worker (templates, house strategies, commit → execute → reveal, missed-marker, alerts)
- M6 deploy files ready and verified (`deploy/`), launch checklist HANDOFF §11

**Working rules**

- Work autonomously. Make reasonable decisions without asking and write them in `DECISIONS.md`.
- Stop and ask only before (a) deploying contracts to Robinhood Chain **mainnet**, (b) anything that spends real funds, (c) when a secret or API key is needed (then list exactly which env vars to fill in).
- After each milestone: run every test, fix failures, update `PROGRESS.md`, commit. Then continue with the next milestone.
- Develop against the anvil fork (`deploy/docker-compose.dev.yml`) so real Uniswap pools and Chainlink feeds are used. Re-verify every address in `config/robinhood.json` with a check script before any mainnet step.
- Security first: the executor key is assumed stolen one day; the worst case must stay `dailyLimit × (slippage + pool fee + oracle lag)` per vault per day. Withdraw must always work.
- Keep the MIT notice from NOUNY in forked contract files and add `THIRD_PARTY_NOTICES.md`.
- No fake data in production paths. Every number in the UI comes from the API or a chain read.

**When finished:** give me (1) a summary of what's built, (2) test results and coverage, (3) the exact list of env vars I must fill, (4) the commands to deploy to my Hostinger VPS from `deploy/DEPLOY.md`, (5) the mainnet deployment command for the contracts, waiting for my go-ahead.

Start with M0 now.
