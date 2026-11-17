#!/usr/bin/env bash
# Zero-downtime redeploy on the VPS. Run as the deploy user from the repo root: ./deploy/deploy.sh
set -euo pipefail

BRANCH="${BRANCH:-main}"
echo "→ Pulling $BRANCH"
git fetch origin "$BRANCH"
git reset --hard "origin/$BRANCH"

echo "→ Installing dependencies"
corepack enable
pnpm install --frozen-lockfile

echo "→ Database migrations"
pnpm prisma migrate deploy

echo "→ Building"
pnpm turbo run build --filter=web --filter=api --filter=worker

echo "→ Reloading processes"
if pm2 describe receipts-api >/dev/null 2>&1; then
  pm2 reload deploy/ecosystem.config.cjs --env production --update-env
else
  pm2 start deploy/ecosystem.config.cjs --env production
fi
pm2 save

echo "→ Health check"
sleep 4
curl -fsS http://127.0.0.1:4000/health && echo
curl -fsS -o /dev/null -w "web %{http_code}\n" http://127.0.0.1:3000/
echo "✓ Deployed $(git rev-parse --short HEAD)"
