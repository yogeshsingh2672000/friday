#!/usr/bin/env bash
# Friday — POSIX setup helper.
set -euo pipefail

need() { command -v "$1" >/dev/null 2>&1 || { echo "Missing: $1"; exit 1; }; }
need node
need pnpm
need docker

echo "==> Friday setup"
if [ ! -f .env ]; then
  cp .env.example .env
  echo "Created .env — fill in API keys."
fi
if [ ! -f apps/renderer/.env ]; then
  cp apps/renderer/.env.example apps/renderer/.env
  echo "Created apps/renderer/.env — fill VITE_PICOVOICE_ACCESS_KEY."
fi

echo "==> pnpm install"
pnpm install

echo "==> docker compose up -d postgres"
docker compose up -d postgres

echo "==> waiting for postgres health"
for _ in $(seq 1 30); do
  status=$(docker inspect --format '{{.State.Health.Status}}' friday-postgres 2>/dev/null || true)
  [ "$status" = "healthy" ] && break
  sleep 1
done

echo "==> pnpm migrate"
pnpm migrate

POR=apps/renderer/public/porcupine_params.pv
if [ ! -f "$POR" ]; then
  echo "==> downloading Porcupine model"
  curl -fL https://github.com/Picovoice/porcupine/raw/master/lib/common/porcupine_params.pv -o "$POR"
fi

echo "==> done. Edit .env, then run: pnpm dev"
