# Deploy guide — Hostinger VPS (Ubuntu 22.04/24.04)

Same infrastructure as other production projects: **PM2 + Nginx**, PostgreSQL 16 and Redis 7 on the box. Replace `receipts.example` with the real `APP_DOMAIN`.

Order of operations: **(A)** contracts from your own machine → **(B)** server setup → **(C)** app → **(D)** Nginx/SSL → **(E)** house strategies → **(F)** monitoring. Contract deploys and anything that spends real funds need the owner's explicit go-ahead.

## A. Contracts (from a local machine, never the server)

Requirements: Foundry (`curl -L https://foundry.paradigm.xyz | bash && foundryup`), Node 20, pnpm (`corepack enable`).

```bash
git clone https://github.com/<org>/receipts.git && cd receipts
git submodule update --init --recursive
pnpm install
cp deploy/env.example .env        # fill RPC_URL (paid key) at least

# 1. re-verify every address in config/robinhood.json on-chain (must print ✓)
pnpm check-config

# 2. all tests green (unit / fuzz / invariant / gas), then fork tests against mainnet state
cd packages/contracts
forge test
anvil --fork-url "$RPC_URL" --chain-id 4663 &          # local fork with real pools + feeds
forge test --match-path 'test/fork/*' --fork-url http://127.0.0.1:8545
DEPLOYMENT_NAME=fork TREASURY_ADDRESS=0x... EXECUTOR_ADDRESS=0x... \
  forge script script/Deploy.s.sol --rpc-url http://127.0.0.1:8545 --private-key <anvil-dev-key> --broadcast   # rehearsal

# 3. MAINNET (owner go-ahead required)
export TREASURY_ADDRESS=0x...        # multisig recommended
export EXECUTOR_ADDRESS=0x...        # address of EXECUTOR_PRIVATE_KEY (default operator of new vaults)
export MAX_DAILY_LIMIT_USD=2000      # beta cap
export PROTOCOL_CUT_BPS=1000
forge script script/Deploy.s.sol --rpc-url "$RPC_URL" --private-key "$DEPLOYER_PRIVATE_KEY" --broadcast
# → writes packages/contracts/deployments/4663.json (registry, factory, startBlock, constructor args)

# 4. verify on Blockscout (SignalRegistry + VaultFactory; vaults match by bytecode)
./script/verify.sh

# 5. anyone can re-check bytecode against the repo
cd ../.. && pnpm verify-deployment
```
Commit `packages/contracts/deployments/4663.json`. Put `REGISTRY_ADDRESS`, `FACTORY_ADDRESS`, `START_BLOCK` (+ the `NEXT_PUBLIC_*` copies) into the server `.env`. Fund the executor and every signer address with a little ETH on Robinhood Chain (0.01 ETH each is plenty; alerts fire below `MIN_GAS_BALANCE_ETH`).

## B. One-time server setup
```bash
# as root
adduser deploy && usermod -aG sudo deploy
apt update && apt upgrade -y
apt install -y git curl ufw nginx certbot python3-certbot-nginx build-essential
ufw allow OpenSSH && ufw allow 'Nginx Full' && ufw enable

# Node 20 + pnpm + PM2
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs
corepack enable && npm i -g pm2
pm2 startup systemd -u deploy --hp /home/deploy

# PostgreSQL 16 + Redis 7 (local only)
apt install -y postgresql redis-server
sudo -u postgres psql -c "CREATE USER receipts WITH PASSWORD 'CHANGE_ME';"
sudo -u postgres psql -c "CREATE DATABASE receipts OWNER receipts;"
sed -i 's/^# *bind 127.0.0.1/bind 127.0.0.1/' /etc/redis/redis.conf && systemctl restart redis-server
```
Postgres and Redis must listen on 127.0.0.1 only. Daily `pg_dump` backup via cron to off-box storage:
```bash
# crontab -e (as deploy)
15 3 * * * pg_dump -Fc receipts > ~/backups/receipts-$(date +\%F).dump && find ~/backups -mtime +14 -delete
```

## C. App
```bash
# as deploy
cd ~ && git clone https://github.com/<org>/receipts.git && cd receipts
cp deploy/env.example .env && nano .env      # fill every REQUIRED value
chmod 600 .env
pnpm install --frozen-lockfile
pnpm prisma migrate deploy
pnpm turbo run build --filter=web --filter=api --filter=worker
pm2 start deploy/ecosystem.config.cjs --env production && pm2 save
curl -fsS http://127.0.0.1:4000/health      # {"ok":true,...}
```
Each app loads the root `.env` itself (dotenv with the repo-root path); Next.js inlines `NEXT_PUBLIC_*` at build time, so rebuild the web app after changing them. Generate secrets with `openssl rand -hex 32` (`SESSION_SECRET`, `SALT_ENCRYPTION_KEY`). **Back up `SALT_ENCRYPTION_KEY`**: without it the worker cannot reveal commits made before a restart.

The worker must run as exactly one process (nonce managers + executor); the API runs 2 instances in cluster mode (rate limits and WebSocket fan-out go through Redis).

## D. Nginx + SSL
```bash
sudo cp deploy/nginx.conf /etc/nginx/sites-available/receipts
sudo sed -i 's/receipts.example/YOUR_DOMAIN/g' /etc/nginx/sites-available/receipts
sudo ln -s /etc/nginx/sites-available/receipts /etc/nginx/sites-enabled/
# First time: comment out the whole `listen 443` server block, then:
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d YOUR_DOMAIN -d www.YOUR_DOMAIN
# Uncomment the 443 block (certbot fills the cert paths), then:
sudo nginx -t && sudo systemctl reload nginx
```
DNS: A record for `@` and `www` → VPS IP (Cloudflare proxy optional; if used, set SSL mode to Full (strict)).

## E. House strategies and vaults
```bash
pnpm tsx scripts/register-house.ts               # dry run: prints metadata URIs and the calls
pnpm tsx scripts/register-house.ts --broadcast   # owner go-ahead: registers Mag7 Rebalance, SPY/QQQ Rotation, News Desk
```
Then, from the house wallet in the web app: create a vault, deposit a small amount of USDG (e.g. $500 per strategy), follow the house strategy, and add the vault addresses to `HOUSE_VAULTS` (and the creator wallet to `HOUSE_CREATORS`) in `.env`; `pm2 reload deploy/ecosystem.config.cjs --update-env`.

## F. Redeploys
```bash
./deploy/deploy.sh          # pulls main, installs, migrates, builds, pm2 reload, health check
```
Optional: GitHub Actions job that SSHes in and runs it on push to `main` after CI passes.

## G. Monitoring
- `pm2 logs`, `pm2 monit`; `pm2 install pm2-logrotate`.
- `SENTRY_DSN` / `NEXT_PUBLIC_SENTRY_DSN` for api, worker and web error reporting.
- Uptime monitor on `https://YOUR_DOMAIN/api/health` (alert if `ok` is false or `indexerLagBlocks > 60`).
- Telegram alerts from the worker (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`): low gas, reveal deadline risk, mismatch, indexer lag > 2 min, tx failure rate > 10 % in 15 min, breaker trips on house vaults.

## H. Launch order
1. Mainnet contracts deployed + verified (beta cap $2,000/day per vault); `pnpm verify-deployment` ✓.
2. App deployed, indexer synced from `START_BLOCK` (`/api/health` lag ≈ 0).
3. House strategies registered; house vaults created and funded with real USDG; addresses in `HOUSE_VAULTS`.
4. 48 h with house strategies only. Zero missed reveals, zero mismatches (`AlertLog`, Telegram).
5. Open to the public. Announce with links to the verified contracts and the repo.
