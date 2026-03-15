# Plaid Runbook

This repo uses Plaid `transactions/sync` with Supabase Edge Functions for:

- initial bank linking
- automatic webhook-driven transaction imports
- manual fallback syncs

## Functions

- `create-link-token`
  - creates the Plaid Link token
  - sets the webhook URL used for new items

- `exchange-token`
  - exchanges the Plaid public token
  - stores/updates the linked `plaid_accounts` row
  - repairs the Plaid webhook URL
  - runs an immediate transaction sync

- `plaid-webhook`
  - handles Plaid webhook notifications
  - runs transaction sync for the matching `item_id`

- `sync-plaid-transactions`
  - authenticated manual fallback sync
  - currently defaults to a full cursor reset for recovery/backfill
  - repairs webhook URLs before syncing

- `debug-plaid-sync`
  - authenticated diagnostics only
  - previews Plaid sync results without normal writes
  - can compare Plaid results against `public.transactions`
  - can run a one-row test write during debugging

## Tables

Expected tables used by the Plaid pipeline:

- `public.plaid_accounts`
  - `id`
  - `user_id`
  - `item_id`
  - `access_token`
  - `cursor`

- `public.transactions`
  - `id`
  - `user_id`
  - `item_id`
  - `plaid_transaction_id`
  - `date`
  - `amount`
  - `name`
  - `merchant_name`
  - `pending`
  - `category`

## Production Gotchas

- Existing Plaid items may have stale webhook configuration.
  - This is why webhook repair runs inside `exchange-token` and `sync-plaid-transactions`.

- Manual sync currently performs a full resync by default.
  - This is intentional and was added to recover from older cursor/filter issues.

- Production `public.transactions` does not currently have an `account_id` column.
  - Do not write `account_id` unless the production schema is updated first.

## Transfer Filtering Policy

The Plaid sync pipeline now filters out transfer/payment noise before insert.

Current rules:

- exclude non-debit rows (`amount <= 0`)
- exclude categories related to transfer / loan / credit-card-payment noise
- exclude name patterns such as:
  - `transfer`
  - `payment thank you`
  - `credit card payment`
  - `capital one`
  - `autopay`
  - `ach payment`
  - `online payment`
  - `mobile banking transfer`
  - `internet banking transfer`
  - `electronic withdrawal`

Examples intended to be excluded:

- `electronic withdrawal capital one`
- `capital one mobile pymt`

## Debug Checklist

When transactions are missing:

1. Confirm the rows are actually missing from `public.transactions`.
2. Check `public.plaid_accounts` for the linked items and cursor state.
3. Use `debug-plaid-sync` to compare:
   - stored cursor preview
   - reset cursor preview
4. If `stored_*` is zero but `reset_added` is positive:
   - Plaid has the transactions
   - either cursor state or write path is the issue
5. If `reset_missing_transaction_count` is positive:
   - Plaid is returning transactions that are not in `public.transactions`
6. If test write fails:
   - fix schema or insert payload mismatch before looking elsewhere

## Useful Console Checks

Call `debug-plaid-sync` from the app console while logged in:

```js
(async () => {
  const { data: { session } } = await supabaseClient.auth.getSession();

  const res = await fetch(`${SUPABASE_URL}/functions/v1/debug-plaid-sync`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${session.access_token}`,
      "apikey": SUPABASE_ANON_KEY,
    },
    body: JSON.stringify({
      include_reset_preview: true,
      sample_limit: 3,
    }),
  });

  const data = await res.json();
  console.log(data);
})();
```

For write-path debugging:

```js
(async () => {
  const { data: { session } } = await supabaseClient.auth.getSession();

  const res = await fetch(`${SUPABASE_URL}/functions/v1/debug-plaid-sync`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${session.access_token}`,
      "apikey": SUPABASE_ANON_KEY,
    },
    body: JSON.stringify({
      include_reset_preview: true,
      sample_limit: 3,
      test_write: true,
    }),
  });

  const data = await res.json();
  console.log(data);
})();
```

## One-Time Cleanup

For old transfer/payment noise already inserted into `public.transactions`, use:

- [plaid-transfer-cleanup.sql](/Users/home/amazon-categorizer/docs/plaid-transfer-cleanup.sql)

Always run the preview query first before executing the delete block.
