#!/usr/bin/env bash
# install.sh — one-shot VPS bootstrap for hft-elon-bot.
#
# Idempotent: re-run safely. Assumes Ubuntu 22.04+ / Debian 12+.
#
# What it does:
#   1. Installs node 24 via nvm (so version matches dev box)
#   2. Installs pm2 globally
#   3. Installs build-essential (better-sqlite3 needs it to compile)
#   4. Installs npm deps
#   5. Compiles better-sqlite3 against the installed node ABI
#   6. Creates data/logs/ dir
#
# What it does NOT do:
#   - Provision the VPS itself (you do this in DO/Hetzner UI)
#   - Configure firewall (bot is outbound-only; nothing to expose)
#   - Set up .env (you copy it manually — secret)
#   - Start the bot (do `pm2 start ecosystem.config.cjs` after this)

set -euo pipefail

NODE_VERSION="24"
PROJECT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"

echo "── hft-elon-bot installer ───────────────────────────────────"
echo "  project: $PROJECT_DIR"
echo "  node version: $NODE_VERSION"
echo "─────────────────────────────────────────────────────────────"

# 1. apt deps
if command -v apt-get >/dev/null 2>&1; then
  echo "[1/6] apt-get install build-essential ..."
  sudo apt-get update -y
  sudo apt-get install -y --no-install-recommends \
    build-essential python3 ca-certificates curl git
else
  echo "[1/6] skipping apt (non-Debian system)"
fi

# 2. nvm + node
if ! command -v nvm >/dev/null 2>&1; then
  if [[ ! -d "$HOME/.nvm" ]]; then
    echo "[2/6] installing nvm ..."
    curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
  fi
  # shellcheck disable=SC1091
  export NVM_DIR="$HOME/.nvm"
  [[ -s "$NVM_DIR/nvm.sh" ]] && source "$NVM_DIR/nvm.sh"
fi
echo "[2/6] node $NODE_VERSION ..."
nvm install "$NODE_VERSION"
nvm use "$NODE_VERSION"
nvm alias default "$NODE_VERSION"

# 3. pm2 global
if ! command -v pm2 >/dev/null 2>&1; then
  echo "[3/6] installing pm2 globally ..."
  npm install -g pm2
else
  echo "[3/6] pm2 already installed: $(pm2 -v)"
fi

# 4. npm install (lock-file-faithful)
cd "$PROJECT_DIR"
echo "[4/6] npm install ..."
if [[ -f package-lock.json ]]; then
  npm ci
else
  npm install
fi

# 5. ensure better-sqlite3 native build matches running node
echo "[5/6] rebuilding native modules for $(node -v) ..."
npm rebuild better-sqlite3

# 6. data dirs
echo "[6/6] mkdir -p data/logs ..."
mkdir -p data/logs

echo ""
echo "✅ install complete"
echo ""
echo "Next steps:"
echo "  1. Copy your .env  →  $PROJECT_DIR/.env"
echo "  2. Generate creds  →  npm run setup-creds   (live mode only)"
echo "  3. Verify          →  npm run smoke && npm run latency"
echo "  4. Start the bot   →  pm2 start ecosystem.config.cjs"
echo "  5. Auto-start      →  pm2 save && pm2 startup   # follow prompt"
echo "  6. Tail logs       →  pm2 logs hft-elon-bot"
