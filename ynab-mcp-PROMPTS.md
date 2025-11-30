Get an itemized list of unaccepted transactions for Amazon starting with the most recent. We only care about those transactions that have no existing memo values.
Use 

ynab:get_transactions
{
  "budget_id": "default",
  "type": "unapproved"
}
// Then filter for payee_name == "Amazon" and memo == null

Then ingest my transaction details using this:
Filesystem:read_text_file
{
  "path": "{{json_file}}"
}

Your job is to correlate date and price with a specific transaction and update the memo from the transaction details. 
Show me a table with the proposed new values.

If you have high confidence in the correlated transactions, proceed to update the ynab transactions to have the updated memo field.

Use ynab:update_transaction
{
  "transaction_id": "<transaction_id>",
  "memo": "[order-id] - description",
  "budget_id": "default"
}

If there's a lack of confidence, then ask for confirmation first. 
