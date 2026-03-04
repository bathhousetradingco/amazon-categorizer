# Plaid Pipeline System Architecture Audit

## Current pipeline diagram

```text
Frontend (Plaid Link)
  ├─ create-link-token (Edge Function)
  ├─ exchange-token (Edge Function)
  │    └─ stores plaid_accounts(user_id, item_id, access_token, cursor)
  └─ sync-plaid-transactions (Edge Function, authenticated manual sync)
       └─ Plaid /transactions/sync
            └─ upsert public.transactions

Plaid Webhooks
  └─ plaid-webhook (Edge Function, verify_jwt=false)
       └─ resolve plaid_accounts by item_id to get user_id + access_token + cursor
       └─ Plaid /transactions/sync
            └─ upsert/delete public.transactions
```

## Identified drift

- Two independent transaction sync implementations existed (legacy sync function and `sync-plaid-transactions`) with different schemas and conflict keys.
- The legacy sync implementation wrote old columns (`plaid_id`, `title`, `vendor`) and conflict key `plaid_id`, while current functions use `plaid_transaction_id`.
- Webhook sync previously did not guarantee `user_id` and `account_id` population for transaction upserts.
- Deploy workflow and Supabase config still included the deprecated legacy sync function.

## Deprecated components

- Deprecated legacy Edge Function removed from source + deploy workflow + function config.
- Legacy table cleanup remains **manual optional** for safety:
  - `public.product_mappings`
  - `public.product_match_memory`

## What changed and why

1. Unified ingestion behavior:
   - Added shared helper `supabase/functions/_shared/plaid-sync.ts` used by both webhook and manual sync.
   - Ensures consistent upsert shape:
     `user_id, item_id, account_id, plaid_transaction_id, date, amount, name, merchant_name, pending, category`.

2. Webhook safety:
   - `plaid-webhook` now resolves account via `plaid_accounts.item_id`, requires `user_id`, and skips writes if unresolved.
   - Prevents orphan rows (`transactions.user_id` null) from webhook path.
   - Kept unauthenticated webhook mode (`verify_jwt = false`) for compatibility.
   - Added TODO note to implement Plaid webhook signature verification.

3. Manual sync parity:
   - `sync-plaid-transactions` now uses the same shared sync helper as webhook.
   - Persists real Plaid `account_id` + `pending` values and upserts on `plaid_transaction_id`.

4. Schema alignment migration:
   - Added non-destructive migration with `add column if not exists` and `create index if not exists`.
   - Adds indexes for lookup and dedupe performance.

5. CI/CD + config alignment:
   - Removed legacy sync deployment/config entries.

## Production verification (safe checks)

1. Deployment:
   - Confirm GitHub Action “Deploy Supabase Edge Functions” passes.

2. Function list:
   - Verify deployed function set includes:
     `analyze-receipt, ask-ai, create-link-token, exchange-token, plaid-webhook, sync-plaid-transactions`.

3. Data integrity checks:

```sql
-- No orphan Plaid rows (user_id should be present when plaid_transaction_id is present)
select count(*) as orphan_plaid_rows
from public.transactions
where plaid_transaction_id is not null
  and user_id is null;

-- Coverage of account_id for Plaid rows
select count(*) as missing_account_id_rows
from public.transactions
where plaid_transaction_id is not null
  and account_id is null;

-- Duplicate plaid transaction ids (should be 0)
select plaid_transaction_id, count(*)
from public.transactions
where plaid_transaction_id is not null
group by plaid_transaction_id
having count(*) > 1;
```

4. Runtime smoke test:
   - Trigger manual `sync-plaid-transactions` for a connected user.
   - Confirm newly synced rows include non-null `user_id`, `item_id`, and populated `account_id` where provided by Plaid.

## Rollback plan

1. Revert this PR in GitHub and redeploy functions.
2. If needed, redeploy previous function bundle via Supabase CLI/GitHub Action.
3. Migration is additive and non-destructive; rollback can be limited to function code/workflow.
4. If any optional legacy table cleanup is later performed manually, restore from DB backups if required.
