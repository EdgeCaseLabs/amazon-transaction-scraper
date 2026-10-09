#!/usr/bin/env bash
# Guided setup for the Amazon <-> YNAB reconciliation system.
# Safe to re-run: never overwrites an existing .env, never edits your Claude config.
set -euo pipefail

bold() { printf '\033[1m%s\033[0m\n' "$1"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$1"; }
step() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

# --- 1. Prerequisites ---------------------------------------------------------
step "1. Checking prerequisites"
missing=0
check() { if command -v "$1" >/dev/null 2>&1; then ok "$1 found ($(command -v "$1"))"; else warn "$1 NOT found${2:+ — $2}"; missing=1; fi; }
check node "install Node 20+"
check pnpm "npm install -g pnpm"
check uv   "curl -LsSf https://astral.sh/uv/install.sh | sh (needed for ynab-mcp)"
check op   "optional: brew install 1password-cli (only for op:// credential refs)"
if [ "$missing" = "1" ]; then warn "Install the missing required tools above, then re-run 'make setup'."; fi

# --- 2. Install + build amazon-transaction-scraper ---------------------------
step "2. Installing amazon-transaction-scraper"
pnpm install
pnpm exec playwright install
pnpm run build
ok "Dependencies installed, Playwright browser ready, dist/ built"

# --- 3. Credentials (.env) ----------------------------------------------------
step "3. Credentials (.env)"
if [ -f .env ]; then
  ok ".env already exists — leaving it untouched"
else
  cp .env.sample .env
  warn "Created .env from template — edit it with your Amazon + Anthropic credentials"
  warn "Each value can be a 1Password op:// reference OR a plaintext value"
fi

# --- 4. ynab-mcp (sibling repo) ----------------------------------------------
step "4. Locating ynab-mcp"
YNAB_DIR=""
for d in "$REPO_DIR/../ynab-mcp" "$HOME/code/ynab-mcp"; do
  if [ -d "$d" ]; then YNAB_DIR="$(cd "$d" && pwd)"; break; fi
done
if [ -n "$YNAB_DIR" ]; then
  ok "Found ynab-mcp at $YNAB_DIR"
  if command -v uv >/dev/null 2>&1; then
    ( cd "$YNAB_DIR" && uv sync )
    [ -f "$YNAB_DIR/.env" ] || ( cp "$YNAB_DIR/.env.sample" "$YNAB_DIR/.env" && warn "Created $YNAB_DIR/.env — add your YNAB_API_KEY" )
    ok "ynab-mcp dependencies synced"
  fi
else
  warn "ynab-mcp not found. Clone it, then re-run:"
  warn "  git clone https://github.com/EdgeCaseLabs/ynab-mcp.git ~/code/ynab-mcp"
fi

# --- 5. Build the correlator skill zip ---------------------------------------
step "5. Building the correlator skill"
make skill >/dev/null
ok "Built ./amazon-ynab-correlator.zip"

# --- 6. Generate the Claude Desktop config snippet ---------------------------
step "6. Claude Desktop config"
NODE_BIN="$(command -v node || echo /path/to/node)"
UV_BIN="$(command -v uv || echo /path/to/uv)"
YNAB_PATH="${YNAB_DIR:-/absolute/path/to/ynab-mcp}"
CFG="$HOME/Library/Application Support/Claude/claude_desktop_config.json"

cat <<JSON

Paste this into: $CFG
(merge the "mcpServers" keys if the file already has some)

{
  "mcpServers": {
    "amazon-transaction-scraper": {
      "command": "$NODE_BIN",
      "args": ["$REPO_DIR/dist/mcp-server.js"],
      "env": {
        "AMAZON_EMAIL": "op://vault/amazon/username",
        "AMAZON_PASSWORD": "op://vault/amazon/password",
        "ANTHROPIC_API_KEY": "op://vault/anthropic/api_key"
      }
    },
    "ynab": {
      "command": "$UV_BIN",
      "args": ["run", "--directory", "$YNAB_PATH", "python", "-m", "ynab_mcp_server"],
      "env": { "YNAB_API_KEY": "your_ynab_api_key_here", "DEFAULT_BUDGET_ID": "" }
    },
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "$REPO_DIR/output"]
    }
  }
}

(Replace op:// refs with plaintext values if you don't use 1Password.)
JSON

# --- 7. Remaining manual steps -----------------------------------------------
step "7. Final manual steps"
cat <<'STEPS'
  1. Edit .env (and ynab-mcp/.env) with real credentials.
  2. Seed the Amazon session ONCE in a visible browser (approves 2FA):
       pnpm start -- -e you@example.com -d 15
  3. Paste the config snippet above into Claude Desktop, then restart it.
  4. Upload the skill zip in Claude Desktop:
       Settings -> Capabilities -> Skills -> upload
       ./amazon-ynab-correlator.zip  (run 'make skill' to rebuild it)
  5. Ask Claude: "Reconcile my unapproved Amazon transactions in YNAB."

See SETUP.md for full details.
STEPS
bold "Setup script complete."
