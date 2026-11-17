# Launch checklist (HANDOFF §11) — status

Legend: ✅ done in the repo · 🟡 ready, needs an owner action (deploy, keys, funds) · ⛔ blocked on the owner

| # | Item | Status | Evidence / what remains |
|---|---|---|---|
| 1 | All three contracts verified on Blockscout; addresses in README and footer | 🟡 | `packages/contracts/script/Deploy.s.sol` + `script/verify.sh` (Blockscout verifier; vaults match by bytecode). Footer and `/config/chain` show addresses as soon as `REGISTRY_ADDRESS` / `FACTORY_ADDRESS` are set. **Needs the mainnet deploy (your go-ahead).** Then add the addresses to README "Deployed contracts". |
| 2 | Public GitHub repo: contracts, worker, strategies, indexer (no secrets) | 🟡 | Everything lives in this repo; `.env` is git-ignored, keys only come from env, logs redact keys / salts / prompts. Make the repository public when ready. |
| 3 | `scripts/verify-deployment.ts`: anyone can compare deployed bytecode to the repo | ✅ | `pnpm verify-deployment [--vault 0x…]` (masks only immutables; `bytecode_hash = none`). Checked against the fork deployment: registry + factory match. |
| 4 | House strategies (Mag7 Rebalance, SPY/QQQ Rotation) live with real funds in public vaults | 🟡 | `scripts/register-house.ts` (dry run by default, `--broadcast` sends). Then create + fund house vaults (e.g. $500 each) from the house wallet in the app and list them in `HOUSE_VAULTS`. **Real funds: your go-ahead.** |
| 5 | Every stat on landing and app comes from the indexer; zero hard-coded numbers | ✅ | Web parses every API response with the shared zod schemas; stats from `GlobalStat` / `Strategy` cached fields computed by the stats job from chain events; empty states when there is no data. Only `scripts/seed-dev.ts` (DEV ONLY, refuses production / non-local DBs) creates sample rows. |
| 6 | Every receipt has a permalink and verifies client-side from chain | ✅ | `/app/s/[id]/receipt/[nonce]`; client-side verification recomputes `hashSignal` from on-chain `Revealed` logs and checks `Executed` logs via the RPC, falling back to the API (page states the source). |
| 7 | Docs page: how commit-reveal works, threat model, worst-case math, fees | ✅ | `/docs`, sourced from SECURITY.md and specs. |
| 8 | Terms + privacy + "not investment advice" + US stock-token notice | 🟡 | `/terms`, `/privacy` are templates marked for legal review; "Not investment advice" in the footer; US notice on stock strategies + `GEOBLOCK_STOCKS=US` (needs Cloudflare `CF-IPCountry` or Nginx geoip2 `X-Country-Code`). **Legal review needed.** |
| 9 | Monitoring: Sentry, uptime check, Telegram alerts (missed reveal risk, low gas, indexer lag > 2 min) | 🟡 | Sentry envelope reporter in api / worker (web: `NEXT_PUBLIC_SENTRY_DSN`); `/api/health` for the uptime monitor; Telegram alerts implemented (reveal risk, mismatch, low gas, indexer lag, tx failure rate, house breaker). **Needs `SENTRY_DSN`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` and an uptime monitor account.** |

Before raising the beta cap: external audit by a recognised firm and a public bug bounty (SECURITY.md).
