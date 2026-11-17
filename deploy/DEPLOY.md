# Deploy guide — Hostinger VPS (Ubuntu 22.04/24.04)

Same infrastructure as other production projects: **PM2 + Nginx**, PostgreSQL 16 and Redis 7 on the box. Replace `receipts.example` with the real `APP_DOMAIN`.

## 1. One-time server setup

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

Postgres and Redis must listen on 127.0.0.1 only. Daily `pg_dump` backup via cron to off-box storage.

## 2. App

```bash
# as deploy
cd ~ && git clone git@github.com:<org>/receipts.git && cd receipts
cp deploy/env.example .env && nano .env      # fill every value; chmod 600 .env
chmod 600 .env
pnpm install --frozen-lockfile
pnpm prisma migrate deploy
pnpm turbo run build --filter=web --filter=api --filter=worker
pm2 start deploy/ecosystem.config.cjs --env production && pm2 save
```

Each app loads the root `.env` (use `dotenv` with `path: '../../.env'` or symlink).

## 3. Nginx + SSL

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

## 4. Contracts (from a local machine, never the server)

```bash
cd packages/contracts
forge test -vvv                                   # all green first
forge script script/Deploy.s.sol --rpc-url $RPC_URL --private-key $DEPLOYER_PRIVATE_KEY --broadcast
# verify on Blockscout
forge verify-contract <ADDRESS> src/SignalRegistry.sol:SignalRegistry --verifier blockscout \
  --verifier-url https://robinhoodchain.blockscout.com/api/ --chain-id 4663
# repeat for VaultFactory (with constructor args) — vaults verify via factory bytecode match
```

Then put `REGISTRY_ADDRESS`, `FACTORY_ADDRESS`, `START_BLOCK` in `.env` and redeploy the app. Fund executor + signer addresses with a little ETH on Robinhood Chain (0.01 ETH each is plenty).

## 5. Redeploys

```bash
./deploy/deploy.sh          # pulls main, installs, migrates, builds, pm2 reload, health check
```

Optional: GitHub Actions job that SSHes in and runs it on push to `main` after CI passes.

## 6. Monitoring

- `pm2 logs`, `pm2 monit`; `pm2 install pm2-logrotate`.
- Sentry DSN for web, api, worker.
- Uptime monitor on `https://YOUR_DOMAIN/api/health` (alert if `indexerLagBlocks > 60`).
- Telegram alerts from the worker (see specs/WORKER.md §7).

## 7. Launch order

1. Mainnet contracts deployed + verified (beta cap $2,000/day per vault).
2. App deployed, indexer synced from `START_BLOCK`.
3. House strategies registered; house vaults created and funded with real USDG; addresses added to landing.
4. 48 h with house strategies only. Zero missed reveals, zero mismatches.
5. Open to the public. Announce with links to the verified contracts and the repo.
