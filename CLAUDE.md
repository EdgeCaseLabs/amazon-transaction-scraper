# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Amazon Transaction Scraper - A TypeScript tool for scraping Amazon transaction data and generating HTML reports. Uses Playwright for browser automation with support for 2FA/passkey authentication.

## Build & Development Commands

```bash
# Build TypeScript to dist/
pnpm run build

# Run the scraper (builds first)
pnpm start -- -e your@email.com

# Development mode with ts-node (no build required)
pnpm run dev

# Run scraper only (no HTML generation)
pnpm run scrape

# Generate HTML from existing JSON
pnpm run generate
pnpm start -- --generate output/data/transactions-2025-07-05.json
```

## Architecture

### Core Components

**Authentication Flow (src/auth.ts)**
- `AmazonAuth` class handles Playwright browser lifecycle
- Supports passkey, 2FA, and challenge authentication
- Waits up to 2 minutes for manual authentication steps
- Maintains browser session with cookies shared across parallel browsers
- Uses realistic user-agent and HTTP headers to avoid bot detection

**Scraping Engine (src/scraper.ts)**
- `AmazonScraper` orchestrates the entire scraping process
- **Parallel Processing**: Uses 4 concurrent browser instances (configurable via `PARALLEL_BROWSERS`)
- **Deduplication**: Loads previously processed orders from existing JSON files to avoid re-scraping
- **Transaction Consolidation**: Merges duplicate orders by `orderId`, combining refunds
- **Pagination**: Automatically handles "Next Page" navigation (up to 10 pages)
- **Refund Logic**: Compares "Refund Total" vs "Grand Total" to determine if order is fully refunded
- **DOM Selectors**: Uses `.apx-transactions-line-item-component-container` for transaction rows

**HTML Generation (src/generator.ts)**
- `HTMLGenerator` creates interactive HTML reports from JSON data
- Color-coded charges (red) vs refunds (green)
- Expandable/collapsible transaction details
- Links to view orders directly on Amazon
- Responsive design with print support

**Data Models (src/types.ts, src/schemas.ts)**
- `TransactionData`: Top-level structure with metadata and transactions array
- `Transaction`: Full order details including refunds array, items, screenshots
- Factory functions in schemas.ts for creating validated objects

**Configuration (src/config.ts)**
- Loads `config.json` from project root
- Dot-notation getter: `config.get('scraping.headless')`
- Auto-saves on set operations

### Data Flow

1. **Login**: `AmazonAuth.login()` → navigates to payments page, handles 2FA
2. **Transaction List**: Scrapes basic transaction data (orderId, total, URL) from payments page
3. **Deduplication**: Filters out previously processed orders using `processedOrders` Set
4. **Parallel Processing**: Divides remaining transactions into 4 chunks
5. **Order Details**: Each browser instance navigates to order detail pages, extracts items/refunds/screenshots
6. **Consolidation**: Merges duplicate orders, combines refund arrays
7. **Save JSON**: Writes to `output/data/transactions-{timestamp}.json`
8. **Generate HTML**: Creates `output/transactions-{timestamp}.html`

### Key Files

- `src/index.ts`: CLI entry point, argument parsing, password prompting
- `src/scraper.ts`: Main scraping logic (1320 lines - largest file)
- `src/generator.ts`: HTML report generation with embedded CSS/JS
- `src/auth.ts`: Browser automation and authentication
- `config.json`: Runtime configuration (not in repo, created on first run)

## Important Implementation Details

### Refund Detection
The scraper looks for both "Refund Total" and "Grand Total" elements on order pages:
- Compares refund amounts to grand total
- Only marks as fully refunded if `totalRefunds >= grandTotal`
- See `extractOrderDetails()` in src/scraper.ts:615-758

### Screenshot Strategy
- Uses idempotent filenames: `order-{orderId}.png` (no counter)
- Takes "smart screenshots" of `.a-cardui` elements when possible
- Hovers over "Refund Total" and "Grand Total" to capture tooltips
- See `takeSmartOrderScreenshot()` in src/scraper.ts:1189-1263

### Parallel Processing
- Launches 4 browser instances simultaneously
- Copies cookies from main session to all instances
- Each browser processes a chunk of transactions independently
- Graceful cleanup on errors
- See `processTransactionsInParallel()` in src/scraper.ts:814-902

### Order Deduplication
- Loads all existing JSON files and screenshots on startup
- Maintains `processedOrders` Set to skip already-scraped orders
- Consolidates duplicate transactions in final output (e.g., orders with multiple refund entries)
- See `loadProcessedOrders()` and `consolidateTransactions()`

### HTML Output
- All paths are relative (screenshots/order-{id}.png)
- JavaScript for expand/collapse and image modal
- Fully self-contained HTML file with embedded CSS
- Color-coded: Green = fully refunded, Red = charged

## Configuration

The `config.json` file controls:
- `scraping.headless`: Set to `false` to see browser (default for 2FA support)
- `scraping.timeout`: Page load timeout (default 30000ms)
- `scraping.delayBetweenRequests`: Anti-bot throttling (default 2000ms)
- `output.dataDir`: JSON storage location (default ./output/data)
- `output.screenshotsDir`: Screenshot storage (default ./output/screenshots)

## Common Tasks

### Updating Amazon DOM Selectors
If Amazon changes their page structure, update selectors in:
- `scrapeTransactionList()`: Transaction row selector (currently `.apx-transactions-line-item-component-container`)
- `extractOrderDetails()`: Refund/Grand Total detection (looks for exact text "Refund Total", "Grand Total")
- `extractItemDetails()`: Product images and names

### Adjusting Parallel Processing
Change `PARALLEL_BROWSERS` constant in `processTransactionsInParallel()` (line 815)

### Modifying Refund Logic
The refund determination logic is in two places:
1. Scraper: `extractOrderDetails()` logs comparison
2. Generator: `createTransactionHTML()` renders color (line 100)

## MCP Server

The scraper can run as an MCP server for use with Claude Desktop or other MCP clients.

### Debugging MCP

Monitor the MCP server logs:
```bash
tail -f ~/Library/Logs/Claude/mcp-server-amazon-scraper.log
```

### MCP-specific behavior

- **No deduplication**: MCP runs always scrape fresh (skipDeduplication=true)
- **Credentials validated at startup**: Server fails immediately if AMAZON_EMAIL, AMAZON_PASSWORD, or ANTHROPIC_API_KEY env vars are missing
- **Credentials resolved on invocation**: 1Password lookups only happen when the tool is actually called

## Dependencies

- **playwright**: Browser automation (requires `pnpm exec playwright install`)
- **fs-extra**: Enhanced file system operations
- **date-fns**: Date parsing and formatting
- **TypeScript**: Full type safety with strict mode enabled
