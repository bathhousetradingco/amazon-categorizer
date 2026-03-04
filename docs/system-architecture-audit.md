# Supabase + Plaid System Architecture Audit

## 1) Plaid pipeline map (verified)

Active pipeline in repository:
1. `create-link-token` creates Plaid Link token with `plaid-webhook` callback.
2. `exchange-token` exchanges `public_token`, stores `access_token` + `item_id` in `plaid_accounts` keyed by `item_id`.
3. `sync-plaid-transactions` supports user-initiated/manual sync from frontend.
4. `plaid-webhook` handles Plaid transaction webhooks and runs sync.

Storage consistency:
- `plaid_accounts` is the source of truth for `item_id`, `access_token`, `cursor`, and `user_id`.
- `transactions.plaid_transaction_id` is the upsert conflict key in active sync functions.

## 2) Legacy/conflicting pipeline detection

Conflicting legacy sync path detected:
- `sync-transactions` function used legacy fields (`plaid_id`, `title`, `vendor`) and different duplicate logic.
- Not referenced by frontend or any current pipeline entry points.

Product memory tables:
- `product_mappings` and `product_match_memory` are not referenced by current code, function handlers, frontend, or migrations in this repository.

## 3) Schema integrity alignment

Required Plaid transaction columns were standardized via migration:
- `id`, `user_id`, `plaid_transaction_id`, `item_id`, `account_id`, `date`, `amount`, `name`, `merchant_name`, `pending`, `receipt_url`.

Also added integrity/performance indexes:
- Unique partial index on `transactions(plaid_transaction_id)` where not null.
- `transactions(user_id, date desc)`.
- `transactions(item_id)`.
- `transactions(account_id)`.

## 4) Deprecated components report (safe cleanup candidates)

Deprecated + removed in repo:
- Edge function source: `supabase/functions/sync-transactions`.
- CI deploy entry for `sync-transactions`.
- Supabase function config section for `sync-transactions`.

Deprecated + removed by migration (if present in DB):
- `public.product_mappings`.
- `public.product_match_memory`.

Drift noted:
- `parse-receipt` is listed as deployed in environment notes but has no source folder in this repository.
  Action: treat as deployment drift and exclude from desired deployment set unless intentionally reintroduced.

## 5) Cleanup plan executed

1. Remove legacy sync function from repository.
2. Keep single sync pipeline: `sync-plaid-transactions` + `plaid-webhook`.
3. Ensure webhook writes include `user_id` by deriving from `plaid_accounts.item_id -> user_id`.
4. Add `account_id` on inserts in webhook and manual sync.
5. Update deploy workflow and Supabase config to deploy/configure only required function set.
6. Apply migration for schema/index hardening and safe legacy table removal.

## 6) Safety verification summary

- No deletion applied to required core components:
  - `plaid_accounts`
  - `transactions`
  - `create-link-token`
  - `exchange-token`
  - `plaid-webhook`
  - `sync-plaid-transactions`
- Legacy removals were performed only after repository-wide reference audit.
