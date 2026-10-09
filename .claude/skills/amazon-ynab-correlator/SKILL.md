---
name: amazon-ynab-correlator
description: Correlate Amazon orders with YNAB transactions. Use when reconciling Amazon purchases, matching YNAB transactions to Amazon orders, or updating YNAB memos with Amazon order details.
---

# Amazon-YNAB Transaction Correlator

## Step 1: Get Unapproved YNAB Transactions
Use ynab:get_transactions
{
  "budget_id": "default",
  "type": "unapproved"
}
Filter results for:
- payee_name contains "Amazon" (case-insensitive)
- memo is null or empty
- Sort by date descending (most recent first)

If no matching transactions found, report this and stop.

## Step 2: Calculate Date Range and Scrape Amazon
From the filtered YNAB transactions:
- Find the oldest transaction date
- Find the newest transaction date
- Add 5 days buffer on each end to account for processing delays

Use amazon-transaction-scraper:scrape_amazon_transactions
{
  "startDate": "<oldest_date - 5 days>",
  "endDate": "<newest_date + 5 days>"
}
Store the returned file path for Step 3.

## Step 3: Load Amazon Transaction Details
Use Filesystem:read_text_file
{
  "path": "<path_from_step_2>"
}

## Step 4: Correlation Logic
Match YNAB transactions to Amazon orders using:
**High Confidence Criteria (auto-update):**
- Exact amount match (within $0.01)
- Date within ±3 days
- Only one possible match
**Medium Confidence Criteria (ask first):**
- Exact amount match but date within ±5 days, OR
- Multiple possible matches with same amount
- Amount matches within $1 for orders with tax/shipping variations
**Low Confidence (skip or ask):**
- No clear match
- Amount significantly different
- Very old transactions (>30 days gap)

## Step 5: Present Findings
Show a table with columns:
- YNAB Date
- YNAB Amount
- Current Memo
- Proposed Memo (format: "[order-id] - item description")
- Amazon Date
- Confidence Level
- Action (Auto/Ask/Skip)
Include summary: X high confidence, Y medium confidence, Z unmatched

## Step 6: Execute Updates
For each matched transaction, use ynab:update_transaction
{
  "transaction_id": "<transaction_id>",
  "memo": "[order-id] - description",
  "budget_id": "default"
}

**High confidence**: Update automatically
**Medium confidence**: Show batch and ask "Update these N transactions?" before updating each one
**Low confidence**: List separately for manual review

Memo format: "[{order_id}] {item_description}"
- For multi-item orders: use first 2-3 items with "..." if more
- Keep under 200 characters
- Include item quantity if >1

## Error Handling
- If amazon-transaction-scraper:scrape_amazon_transactions fails, ask to retry or use Filesystem:read_text_file with manual path
- If no unapproved Amazon transactions found, report this and stop early
- If correlation finds no matches, report unmatched YNAB transactions for manual review
