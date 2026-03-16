alter table if exists public.transactions
  add column if not exists review_status text;

alter table if exists public.transactions
  add column if not exists deduction_status text;

alter table if exists public.transactions
  add column if not exists review_note text;
