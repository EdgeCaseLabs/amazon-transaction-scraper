# Setup Guide — Amazon ↔ YNAB Reconciliation

End-to-end setup for using the **Amazon Transaction Scraper** together with the
**YNAB MCP server** and the **amazon-ynab-correlator** skill, driven from
**Claude Desktop** (or Claude Code).

This is the one place that documents the *whole system*. The YNAB MCP server
also stands alone — see [its README](https://github.com/EdgeCaseLabs/ynab-mcp) —
but everything you need to wire the two together is here.

---

## What you're building

Three pieces that work together:

```
┌──────────────────────────────────┐   ┌──────────────────────────────────┐
│  amazon-transaction-scraper (MCP)│   │  ynab-mcp (MCP)                  │
│  - scrape_amazon_transactions    │   │  - get_transactions              │
│  - writes JSON file              │   │  - update_transaction            │
└─────────────────┬────────────────┘   └─────────────────┬────────────────┘
                  │                                      │
                  └──────────────────┬───────────────────┘
                                     │
                   ┌─────────────────▼────────────────┐
                   │  amazon-ynab-correlator (skill)  │
                   │  - matches orders <-> txns       │
                   │  - writes memos back to YNAB     │
                   └──────────────────────────────────┘
```

The correlator skill asks Claude to:
1. Pull unapproved Amazon transactions from YNAB.
2. Scrape the matching Amazon orders.
3. Read the scraper's output file.
4. Match them and write memos back to YNAB.

Because the skill calls tools by name, **the MCP server keys in your config must
be exactly `amazon-transaction-scraper` and `ynab`** (see below), and a **Filesystem MCP** is
required so Claude can read the scraper's output file.

---

## Quick start (`make setup`)

If you've already cloned both repos as siblings (e.g. `~/code/amazon-transaction-scraper`
and `~/code/ynab-mcp`), run the guided setup from the scraper repo:

```bash
cd amazon-transaction-scraper
make setup
```

It checks prerequisites, installs + builds the scraper, creates `.env` files from
templates, syncs ynab-mcp, builds the correlator skill zip, and **prints a ready-to-paste
Claude Desktop config with your real absolute paths filled in**. It never overwrites an
existing `.env` and never edits your Claude config for you.

Afterward you still do three things by hand (the script reminds you): fill in credentials,
seed the Amazon session once in a visible browser, and paste the config + upload the skill
in Claude Desktop. The rest of this doc explains each step in full.

---

## Prerequisites

| Tool | Version | Install |
|------|---------|---------|
| Node.js | 20+ | https://nodejs.org or `mise`/`nvm` |
| pnpm | latest | `npm install -g pnpm` |
| Python | 3.10+ | — |
| uv | latest | `curl -LsSf https://astral.sh/uv/install.sh \| sh` |
| 1Password CLI (`op`) | optional | `brew install 1password-cli` (only if using `op://` refs) |
| Claude Desktop | latest | https://claude.ai/download |

Accounts/keys you'll need:
- An **Amazon** account (with 2FA — expected).
- An **Anthropic API key** — https://console.anthropic.com/ (the scraper uses
  Claude Haiku to summarize orders; required for the MCP path).
- A **YNAB Personal Access Token** — https://app.ynab.com/settings/developer.

---

## 1. Clone both repos

```bash
mkdir -p ~/code && cd ~/code
git clone https://github.com/EdgeCaseLabs/amazon-transaction-scraper.git
git clone https://github.com/EdgeCaseLabs/ynab-mcp.git ynab-mcp
```

> Always install from a **fresh git clone**. Do not copy an existing working
> directory — it may contain `.env` / `.password` with live credentials.

---

## 2. Set up amazon-transaction-scraper

```bash
cd ~/code/amazon-transaction-scraper
pnpm install
pnpm exec playwright install      # downloads the browser Playwright drives
pnpm run build                    # compiles to dist/ (MCP runs from dist/)
```

### Credentials

Credentials come from environment variables, which you set **either** in a
`.env` file (for CLI use) **or** in the Claude Desktop config `env` block (for
MCP use — see step 4). Each value can be:

- a **1Password reference** like `op://vault/item/password` (requires `op` CLI +
  `op signin`), **or**
- a **plaintext value** like `your@email.com` / `hunter2`.

The resolver passes any value that doesn't start with `op://` straight through,
so plaintext "just works".

For CLI runs, copy the sample:

```bash
cp .env.sample .env
# edit .env
```

```bash
OP_ACCOUNT=my                                   # 1Password account (default "my")
AMAZON_EMAIL=op://vault/amazon/username          # or: you@example.com
AMAZON_PASSWORD=op://vault/amazon/password        # or: your-password
AMAZON_OTP=op://vault/amazon/one-time password    # optional; enables auto-2FA
ANTHROPIC_API_KEY=op://vault/anthropic/api_key    # or: sk-ant-...
```

> `.env` and `.password` are gitignored. Never commit real credentials.

### First run — seed the Amazon session (important)

Amazon requires 2FA, and **the first login must be done in a visible browser so
you can approve it**. The scraper handles this automatically:

- When there is **no saved session** (`.auth/amazon-state.json` missing), the
  browser launches **visible even if `headless: true`** is set, so you can
  approve the passkey/2FA prompt.
- After a successful login it saves the session to `.auth/`, and later runs
  reuse it and can run **headless/unattended**.
- The scraper also clicks past Amazon's "Use your passkey" page automatically
  (choosing "Enter your password"), so you are **not** forced to use a passkey.

Seed it once from the CLI before relying on the MCP/scheduled runs:

```bash
pnpm start -- -e you@example.com -d 15
# approve the 2FA prompt in the browser that opens
```

When Amazon later expires the saved session, just run a visible scrape again to
re-seed `.auth/`.

---

## 3. Set up ynab-mcp

> Install **from source** (not `uvx`/PyPI) so you get the pinned SDK version
> this project is tested against.

```bash
cd ~/code/ynab-mcp
uv sync
cp .env.sample .env
# edit .env: set YNAB_API_KEY=... (and optionally DEFAULT_BUDGET_ID)
```

Verify it runs:

```bash
uv run python -m ynab_mcp_server
# Ctrl-C to stop
```

Full details and the complete tool list live in the ynab-mcp README.

---

## 4. Configure Claude Desktop MCP servers

Edit (create if missing):

```
~/Library/Application Support/Claude/claude_desktop_config.json
```

Use **absolute paths**. Find them with:

```bash
which node    # e.g. /Users/you/.local/share/mise/.../bin/node
which uv      # e.g. /Users/you/.local/bin/uv
```

```json
{
  "mcpServers": {
    "amazon-transaction-scraper": {
      "command": "/absolute/path/to/node",
      "args": ["/Users/you/code/amazon-transaction-scraper/dist/mcp-server.js"],
      "env": {
        "OP_ACCOUNT": "my",
        "AMAZON_EMAIL": "op://vault/amazon/username",
        "AMAZON_PASSWORD": "op://vault/amazon/password",
        "AMAZON_OTP": "op://vault/amazon/one-time password",
        "ANTHROPIC_API_KEY": "op://vault/anthropic/api_key"
      }
    },
    "ynab": {
      "command": "/absolute/path/to/uv",
      "args": [
        "run",
        "--directory",
        "/Users/you/code/ynab-mcp",
        "python",
        "-m",
        "ynab_mcp_server"
      ],
      "env": {
        "YNAB_API_KEY": "your_ynab_api_key_here",
        "DEFAULT_BUDGET_ID": ""
      }
    },
    "filesystem": {
      "command": "npx",
      "args": [
        "-y",
        "@modelcontextprotocol/server-filesystem",
        "/Users/you/code/amazon-transaction-scraper/output"
      ]
    }
  }
}
```

Notes:
- **Server keys matter.** The correlator skill calls `amazon-transaction-scraper:…`,
  `ynab:…`, and `Filesystem:read_text_file`. Keep the keys `amazon-transaction-scraper`,
  `ynab`, and `filesystem` as shown.
- **Plaintext alternative:** instead of `op://…` refs in the `env` block, you
  can paste the literal values (`"AMAZON_EMAIL": "you@example.com"`, etc.). The
  config file then contains secrets in plaintext — protect it accordingly.
- If you use `op://` refs, 1Password must be signed in (`op signin`) in the
  environment Claude Desktop launches from. Plaintext avoids that dependency.
- The `filesystem` server is scoped to the scraper's `output/` directory so
  Claude can read the JSON the scraper writes.

Restart Claude Desktop after editing.

---

## 5. Install the correlator skill

The skill lives at
`amazon-transaction-scraper/.claude/skills/amazon-ynab-correlator/`.

- **Claude Code:** it's already in `.claude/skills/` — available automatically
  when you work in the repo.
- **Claude Desktop / claude.ai:** upload the skill as a `.zip` via
  **Settings → Capabilities → Skills**. Build a clean zip from the repo root:

  ```bash
  make skill    # writes ./amazon-ynab-correlator.zip (gitignored)
  ```

  Re-run `make skill` and re-upload whenever `SKILL.md` changes.

---

## 6. Run a reconciliation

With the Amazon session seeded (step 2) and Claude Desktop restarted, ask Claude:

> "Reconcile my unapproved Amazon transactions in YNAB."

Claude will run the correlator: pull unapproved Amazon payees from YNAB, scrape
the matching date range, read the output file, match by amount/date, and (with
your confirmation for lower-confidence matches) write memos back to YNAB.

---

## Troubleshooting

| Symptom | Cause / Fix |
|--------|-------------|
| Scraper hangs / times out on login | Saved session expired or never seeded. Run a **visible** CLI scrape (step 2) to approve 2FA and re-seed `.auth/`. |
| "Use your passkey" page blocks login | Handled automatically; if Amazon changed the button text, the password link selector in `src/auth.ts` (`dismissPasskeyPrompt`) may need updating. |
| "Missing credentials" from MCP | `AMAZON_EMAIL` / `AMAZON_PASSWORD` not set (or `op` not signed in). Check the `env` block in the Desktop config. |
| "Missing ANTHROPIC_API_KEY" | The MCP path requires it for order summaries. Add it to the `env` block. |
| Correlator can't read the output file | `filesystem` MCP missing or not scoped to `amazon-transaction-scraper/output`. |
| Tools not found by the skill | MCP server keys must be `amazon-transaction-scraper`, `ynab`, `filesystem`. Restart Claude Desktop. |
| YNAB `create_transaction` errors | Make sure ynab-mcp was installed **from source** (pinned SDK), not from PyPI. |

---

## Security checklist before sharing

- [ ] Share via **git clone**, never by copying your working folder.
- [ ] `.env`, `.password`, and `.auth/` are gitignored and **not** included.
- [ ] If using the plaintext config option, treat
      `claude_desktop_config.json` as a secret file.
- [ ] Rotate any Amazon password, YNAB token, or Anthropic key that may have
      been exposed.
