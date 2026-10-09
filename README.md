# Amazon Transaction Scraper

A TypeScript-based tool to scrape Amazon transaction data and generate human-readable HTML reports with product images and order screenshots.

> **Reconciling Amazon purchases against YNAB?** This scraper pairs with the
> [YNAB MCP server](https://github.com/EdgeCaseLabs/ynab-mcp) and the
> `amazon-ynab-correlator` skill to match orders to YNAB transactions and write
> memos automatically. See **[SETUP.md](SETUP.md)** for the full end-to-end
> install (both servers + Claude Desktop config).

## Features

- **Secure Authentication**: Handles Amazon login with 2FA support
- **1Password Integration**: Use `op://` references to securely fetch credentials
- **Transaction Scraping**: Extracts transaction data from Amazon's payments page
- **Order Details**: Scrapes individual order pages for detailed product information
- **Product Images**: Captures product images and order screenshots
- **Product Summaries**: Generates text summaries and memos from order pages
- **Smart Refund Logic**: Compares "Refund Total" vs "Grand Total" to determine if an order is fully refunded
- **Direct Amazon Links**: Includes clickable links to view orders directly on Amazon
- **JSON Export**: Saves all data in structured JSON format
- **HTML Reports**: Generates beautiful, interactive HTML reports with color-coded charges
- **Date Filtering**: Specify custom date ranges (default: 90 days)
- **TypeScript**: Full type safety and modern development experience

## Prerequisites

- **Node.js 20+** and **pnpm** (`npm install -g pnpm`)
- Playwright browser (installed below)
- An **Anthropic API key** (used for AI order summaries; required for the MCP path)
- *(Optional)* **1Password CLI** (`op`) if you store credentials as `op://` references

## Installation

```bash
# Install dependencies
pnpm install

# Install Playwright browsers
pnpm exec playwright install

# Build (required before running the MCP server)
pnpm run build
```

## Usage

### Scrape Transactions

```bash
# Basic usage (password will be prompted securely)
pnpm start -- -e your@email.com

# Custom date range (30 days)
pnpm start -- -e your@email.com -d 30

# Custom output name
pnpm start -- -e your@email.com -o quarterly-report
```

### Generate HTML from Existing JSON

```bash
pnpm start -- --generate output/data/transactions-2024-07-05.json
```

### Using 1Password CLI (Optional)

For secure credential management without manual entry:

1. **Setup 1Password CLI**:
   ```bash
   # Install 1Password CLI
   brew install 1password-cli

   # Sign in
   op signin
   ```

2. **Create .env file**:
   ```bash
   # Copy the sample
   cp .env.sample .env

   # Edit with your 1Password references
   nano .env
   ```

3. **Example .env with 1Password references**:
   ```bash
   OP_ACCOUNT=my
   AMAZON_EMAIL=op://vault/item-id/username
   AMAZON_PASSWORD=op://vault/item-id/password
   AMAZON_OTP=op://vault/item-id/one-time password
   ```

   Note: `?attribute=otp` is automatically appended to the OTP reference.

4. **Run without prompts**:
   ```bash
   pnpm start -- -d 15
   # Credentials are automatically fetched from 1Password!
   ```

### Command Line Options

- `-e, --email <email>`: Amazon account email
- `-d, --days <number>`: Number of days to scrape (default: 90)
- `-o, --output <name>`: Output file name prefix (default: transactions)
- `-g, --generate <file>`: Generate HTML from existing JSON file
- `-h, --help`: Show help message

**Note:** Password is prompted securely at runtime and will not appear in bash history.

## MCP Server (Claude Desktop / Claude Code)

The scraper can run as an [MCP](https://modelcontextprotocol.io) server, exposing
a `scrape_amazon_transactions` tool that AI clients (and the
`amazon-ynab-correlator` skill) call directly.

```bash
# Build first, then run the MCP server over stdio
pnpm run build
pnpm run mcp          # = node dist/mcp-server.js
```

Credentials are read from environment variables (`AMAZON_EMAIL`,
`AMAZON_PASSWORD`, optional `AMAZON_OTP`, and `ANTHROPIC_API_KEY`). Each value may
be a **plaintext value** or a **1Password `op://` reference** — anything not
starting with `op://` is used as-is.

To register it in **Claude Desktop**, add a server under `mcpServers` in
`~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "amazon-transaction-scraper": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/amazon-transaction-scraper/dist/mcp-server.js"],
      "env": {
        "OP_ACCOUNT": "my",
        "AMAZON_EMAIL": "op://vault/amazon/username",
        "AMAZON_PASSWORD": "op://vault/amazon/password",
        "ANTHROPIC_API_KEY": "op://vault/anthropic/api_key"
      }
    }
  }
}
```

> Use plaintext values here instead of `op://` refs if you don't use 1Password.
> The config file then holds secrets in plaintext — protect it accordingly.

For the complete setup (YNAB MCP server + the correlator skill), see
**[SETUP.md](SETUP.md)**.

## Authentication & Sessions

- **First login must be visible.** Amazon requires 2FA, so the first run opens a
  **visible browser even when `headless: true`** — approve the 2FA/passkey prompt
  once. The session is then saved to `.auth/amazon-state.json`.
- **Later runs reuse the session** and can run headless/unattended until Amazon
  expires it. When that happens, run a visible scrape again to re-seed `.auth/`.
- **Passkeys are declined automatically.** The scraper clicks past Amazon's
  "Use your passkey" page (choosing "Enter your password"), so you are never
  forced to register or use a passkey.
- `.auth/` is gitignored (it holds session cookies).

## Development

### Build

```bash
pnpm run build
```

### Development Mode

```bash
pnpm run dev
```

## Output Structure

```
amazon-transaction-scraper/
├── output/
│   ├── data/           # JSON data files
│   ├── screenshots/    # Order screenshots  
│   └── *.html          # HTML reports
└── config.json         # Configuration file
```

## Configuration

The tool creates a `config.json` file with default settings:

```json
{
  "amazon": {
    "email": "",
    "baseUrl": "https://www.amazon.com",
    "paymentsUrl": "https://www.amazon.com/cpe/yourpayments/transactions",
    "orderUrlPattern": "https://www.amazon.com/gp/your-account/order-details"
  },
  "scraping": {
    "headless": false,
    "timeout": 30000,
    "delayBetweenRequests": 2000,
    "maxRetries": 3
  },
  "output": {
    "dataDir": "./output/data",
    "outputDir": "./output",
    "screenshotsDir": "./output/screenshots"
  },
  "dateRange": {
    "defaultDays": 90
  }
}
```

## Data Format

### JSON Structure

```json
{
  "metadata": {
    "dateRange": {
      "start": "2024-01-01",
      "end": "2024-03-31"
    },
    "totalTransactions": 25,
    "totalAmount": 1250.75,
    "generatedAt": "2024-07-05T10:30:00Z"
  },
  "transactions": [
    {
      "orderId": "123-456-789",
      "date": "2024-01-15",
      "total": 45.99,
      "refunds": [],
      "grandTotal": 45.99,
      "recipient": "John Doe",
      "orderDetailsUrl": "https://www.amazon.com/gp/your-account/order-details?orderID=123-456-789",
      "items": [
        {
          "name": "Product Name",
          "price": 45.99,
          "quantity": 1,
          "imageUrl": "path/to/image.jpg"
        }
      ],
      "orderScreenshot": "output/screenshots/order-123.png"
    }
  ]
}
```

## Important Notes

### Legal and Ethical Use

- This tool is for **personal use only**
- Use only with your own Amazon account
- Respect Amazon's terms of service
- Do not use for commercial purposes
- Be mindful of rate limiting to avoid account restrictions

### Security

- Never commit your credentials to version control
- Password is prompted securely and masked with asterisks
- Passwords do not appear in command history or process lists
- 2FA is fully supported; see **Authentication & Sessions** above for how the
  first-run visible login and saved session work
- `.env`, `.password`, and `.auth/` are gitignored. `.password` is an optional
  local file some flows read a password from — treat it as a secret and never
  commit or share it
- When sharing this project, do so via a **fresh `git clone`**, not by copying
  your working folder (which may contain live credentials)

### Limitations

- Amazon's page structure may change, requiring selector updates
- Heavy usage may trigger anti-bot measures
- Some transactions may require manual verification
- Product images depend on Amazon's image availability

## Troubleshooting

### Common Issues

1. **Login fails**: Check credentials and 2FA settings
2. **No transactions found**: Verify date range and page structure
3. **Screenshots empty**: Check output directory permissions
4. **Build errors**: Ensure TypeScript dependencies are installed

### Debug Mode

Set `"headless": false` in config.json to see browser interaction.

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests if applicable
5. Submit a pull request

## License

This project is for educational and personal use only. Use responsibly and in accordance with Amazon's terms of service.