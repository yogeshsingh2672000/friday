# Friday — Windows setup helper.
# Usage: from repo root, in PowerShell:
#   pwsh -ExecutionPolicy Bypass -File ./scripts/setup.ps1

$ErrorActionPreference = 'Stop'

function Require-Cmd($name) {
  if (-not (Get-Command $name -ErrorAction SilentlyContinue)) {
    Write-Error "Missing required command: $name"
    exit 1
  }
}

Write-Host "==> Friday setup starting" -ForegroundColor Cyan

Require-Cmd node
Require-Cmd pnpm
Require-Cmd docker

$node = (node -v).TrimStart('v')
if ([version]$node -lt [version]"20.11.0") {
  Write-Error "Node >= 20.11 required (have $node)"; exit 1
}

if (-not (Test-Path ".env")) {
  Copy-Item ".env.example" ".env"
  Write-Host "Created .env from .env.example — fill in API keys before `pnpm dev`." -ForegroundColor Yellow
}

if (-not (Test-Path "apps/renderer/.env")) {
  Copy-Item "apps/renderer/.env.example" "apps/renderer/.env"
  Write-Host "Created apps/renderer/.env — fill in VITE_PICOVOICE_ACCESS_KEY." -ForegroundColor Yellow
}

Write-Host "==> Installing workspace deps (pnpm install)" -ForegroundColor Cyan
pnpm install

Write-Host "==> Starting Postgres (docker compose up -d postgres)" -ForegroundColor Cyan
docker compose up -d postgres

Write-Host "==> Waiting for Postgres health" -ForegroundColor Cyan
$tries = 0
while ($tries -lt 30) {
  $health = docker inspect --format '{{.State.Health.Status}}' friday-postgres 2>$null
  if ($health -eq 'healthy') { break }
  Start-Sleep -Seconds 1
  $tries++
}
if ($health -ne 'healthy') {
  Write-Warning "Postgres did not report healthy — continuing anyway."
}

Write-Host "==> Running pgvector + schema migration" -ForegroundColor Cyan
pnpm migrate

$porPath = "apps/renderer/public/porcupine_params.pv"
if (-not (Test-Path $porPath)) {
  Write-Host "==> Downloading Porcupine model (~1.7MB, only used if a Picovoice key is set)" -ForegroundColor Cyan
  $url = "https://github.com/Picovoice/porcupine/raw/master/lib/common/porcupine_params.pv"
  try {
    Invoke-WebRequest -Uri $url -OutFile $porPath -ErrorAction Stop
  } catch {
    Write-Warning "Could not download Porcupine model — wake word will be disabled. You can still use Space / Wake button."
  }
} else {
  Write-Host "Porcupine model already present." -ForegroundColor Green
}

Write-Host ""
Write-Host "==> Friday setup complete." -ForegroundColor Green
Write-Host "Edit .env (AWS Bedrock / Deepgram / ElevenLabs keys; Picovoice optional), then run:" -ForegroundColor Green
Write-Host "    pnpm dev" -ForegroundColor White
