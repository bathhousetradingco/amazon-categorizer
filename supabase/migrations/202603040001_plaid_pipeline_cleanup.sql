-- Plaid pipeline cleanup (safe/non-destructive)
-- Align transactions schema used by plaid-webhook + sync-plaid-transactions.

alter table if exists public.transactions
  add column if not exists account_id text,
  add column if not exists item_id text,
  add column if not exists plaid_transaction_id text,
  add column if not exists pending boolean,
  add column if not exists merchant_name text,
  add column if not exists name text,
  add column if not exists user_id uuid;

create unique index if not exists transactions_plaid_transaction_id_unique_not_null_idx
  on public.transactions(plaid_transaction_id)
  where plaid_transaction_id is not null;

create index if not exists transactions_user_id_date_desc_idx
  on public.transactions(user_id, date desc);

create index if not exists transactions_item_id_idx
  on public.transactions(item_id);

create index if not exists transactions_account_id_idx
  on public.transactions(account_id);

-- Legacy cleanup:
-- Repo-wide search shows no references to these legacy tables, but to avoid unknown
-- production dependencies this migration does not auto-drop them.
-- Manual optional cleanup after production validation:
--   drop table if exists public.product_mappings;
--   drop table if exists public.product_match_memory;
