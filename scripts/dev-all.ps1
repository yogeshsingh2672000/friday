# Friday — one-shot dev launcher.
# Runs renderer (Vite), orchestrator, and Electron together via `pnpm dev`.
# Postgres must already be up (`pnpm db:up`).

$ErrorActionPreference = 'Stop'

Write-Host "==> Starting Postgres if not running" -ForegroundColor Cyan
docker compose up -d postgres | Out-Null

Write-Host "==> pnpm dev" -ForegroundColor Cyan
pnpm dev
