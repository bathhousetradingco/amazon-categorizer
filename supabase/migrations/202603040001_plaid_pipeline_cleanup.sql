-- Plaid pipeline cleanup + hardening
-- Safe, non-destructive alignment for transactions schema used by edge functions/frontend.

alter table if exists public.transactions
  add column if not exists plaid_transaction_id text,
  add column if not exists item_id text,
  add column if not exists account_id text,
  add column if not exists date date,
  add column if not exists amount numeric,
  add column if not exists name text,
  add column if not exists merchant_name text,
  add column if not exists pending boolean,
  add column if not exists receipt_url text;

create unique index if not exists transactions_plaid_transaction_id_unique_idx
  on public.transactions(plaid_transaction_id)
  where plaid_transaction_id is not null;

create index if not exists transactions_user_id_date_desc_idx
  on public.transactions(user_id, date desc);

create index if not exists transactions_item_id_idx
  on public.transactions(item_id);

create index if not exists transactions_account_id_idx
  on public.transactions(account_id);

-- Legacy unused tables removed after repository reference audit.
drop table if exists public.product_mappings;
drop table if exists public.product_match_memory;
