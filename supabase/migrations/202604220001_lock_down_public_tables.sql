-- Lock down app tables that predate the migration history or contain
-- server-only integration data. Public/anon clients should not be able to read
-- any business, receipt, bank, or OAuth-token rows by project URL alone.

create or replace function pg_temp.drop_public_policies(target_table text)
returns void
language plpgsql
as $$
declare
  policy_record record;
begin
  for policy_record in
    select policyname
    from pg_policies
    where schemaname = 'public'
      and tablename = target_table
  loop
    execute format(
      'drop policy if exists %I on public.%I',
      policy_record.policyname,
      target_table
    );
  end loop;
end;
$$;

do $$
begin
  if to_regclass('public.transactions') is not null then
    alter table public.transactions enable row level security;
    alter table public.transactions force row level security;
    perform pg_temp.drop_public_policies('transactions');

    revoke all on table public.transactions from anon;
    grant select, insert, update, delete on table public.transactions to authenticated;

    create policy transactions_select_own
      on public.transactions
      for select
      to authenticated
      using (auth.uid() = user_id);

    create policy transactions_insert_own
      on public.transactions
      for insert
      to authenticated
      with check (auth.uid() = user_id);

    create policy transactions_update_own
      on public.transactions
      for update
      to authenticated
      using (auth.uid() = user_id)
      with check (auth.uid() = user_id);

    create policy transactions_delete_own
      on public.transactions
      for delete
      to authenticated
      using (auth.uid() = user_id);
  end if;

  if to_regclass('public.plaid_accounts') is not null then
    alter table public.plaid_accounts enable row level security;
    alter table public.plaid_accounts force row level security;
    perform pg_temp.drop_public_policies('plaid_accounts');

    revoke all on table public.plaid_accounts from anon;
    revoke all on table public.plaid_accounts from authenticated;
  end if;

  if to_regclass('public.amazon_business_connections') is not null then
    alter table public.amazon_business_connections enable row level security;
    alter table public.amazon_business_connections force row level security;
    perform pg_temp.drop_public_policies('amazon_business_connections');

    revoke all on table public.amazon_business_connections from anon;
    revoke all on table public.amazon_business_connections from authenticated;
  end if;

  if to_regclass('public.amazon_business_oauth_states') is not null then
    alter table public.amazon_business_oauth_states enable row level security;
    alter table public.amazon_business_oauth_states force row level security;
    perform pg_temp.drop_public_policies('amazon_business_oauth_states');

    revoke all on table public.amazon_business_oauth_states from anon;
    revoke all on table public.amazon_business_oauth_states from authenticated;
  end if;

  if to_regclass('public.amazon_business_order_line_items') is not null then
    alter table public.amazon_business_order_line_items enable row level security;
    alter table public.amazon_business_order_line_items force row level security;
    perform pg_temp.drop_public_policies('amazon_business_order_line_items');

    revoke all on table public.amazon_business_order_line_items from anon;
    revoke all on table public.amazon_business_order_line_items from authenticated;
  end if;

  if to_regclass('public.product_lookup_cache') is not null then
    alter table public.product_lookup_cache enable row level security;
    alter table public.product_lookup_cache force row level security;
    perform pg_temp.drop_public_policies('product_lookup_cache');

    revoke all on table public.product_lookup_cache from anon;
    revoke all on table public.product_lookup_cache from authenticated;
  end if;

  if to_regclass('public.product_lookup') is not null then
    alter table public.product_lookup enable row level security;
    alter table public.product_lookup force row level security;
    perform pg_temp.drop_public_policies('product_lookup');

    revoke all on table public.product_lookup from anon;
    grant select, insert, update on table public.product_lookup to authenticated;

    create policy product_lookup_select_authenticated
      on public.product_lookup
      for select
      to authenticated
      using (auth.uid() is not null);

    create policy product_lookup_insert_verified
      on public.product_lookup
      for insert
      to authenticated
      with check (auth.uid() is not null and verified_by_user = true);

    create policy product_lookup_update_verified
      on public.product_lookup
      for update
      to authenticated
      using (auth.uid() is not null)
      with check (auth.uid() is not null and verified_by_user = true);
  end if;

  if to_regclass('public.product_lookup_audit') is not null then
    alter table public.product_lookup_audit enable row level security;
    alter table public.product_lookup_audit force row level security;
    perform pg_temp.drop_public_policies('product_lookup_audit');

    revoke all on table public.product_lookup_audit from anon;
    grant select, insert on table public.product_lookup_audit to authenticated;

    create policy product_lookup_audit_select_own
      on public.product_lookup_audit
      for select
      to authenticated
      using (auth.uid() = user_id);

    create policy product_lookup_audit_insert_own
      on public.product_lookup_audit
      for insert
      to authenticated
      with check (auth.uid() = user_id);
  end if;

  -- Legacy tables documented in the old architecture audit are no longer used
  -- by the app. Keep them inaccessible if they still exist in production.
  if to_regclass('public.product_mappings') is not null then
    alter table public.product_mappings enable row level security;
    alter table public.product_mappings force row level security;
    perform pg_temp.drop_public_policies('product_mappings');

    revoke all on table public.product_mappings from anon;
    revoke all on table public.product_mappings from authenticated;
  end if;

  if to_regclass('public.product_match_memory') is not null then
    alter table public.product_match_memory enable row level security;
    alter table public.product_match_memory force row level security;
    perform pg_temp.drop_public_policies('product_match_memory');

    revoke all on table public.product_match_memory from anon;
    revoke all on table public.product_match_memory from authenticated;
  end if;

  if to_regclass('public.receipts') is not null then
    alter table public.receipts enable row level security;
    alter table public.receipts force row level security;
    perform pg_temp.drop_public_policies('receipts');

    revoke all on table public.receipts from anon;
    revoke all on table public.receipts from authenticated;
  end if;
end $$;
