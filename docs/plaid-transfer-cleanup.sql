-- One-time cleanup for Plaid transfer / credit noise already imported into
-- public.transactions before debit-only filtering was added to the sync pipeline.
--
-- Intended removals include rows like:
-- - "electronic withdrawal capital one"
-- - "capital one mobile pymt"
-- - "payment thank you"
-- - bank transfer / autopay / online payment noise
-- - inbound credits and deposits (amount <= 0)
--
-- Run the preview query first and review the output before executing DELETE.

with candidate_rows as (
  select
    id,
    user_id,
    plaid_transaction_id,
    date,
    amount,
    coalesce(name, '') as name,
    coalesce(merchant_name, '') as merchant_name,
    coalesce(category, '') as category
  from public.transactions
  where plaid_transaction_id is not null
    and (
      amount <= 0
      or lower(coalesce(category, '')) like '%transfer%'
      or lower(coalesce(category, '')) like '%loan%'
      or lower(coalesce(name, '')) like '%transfer%'
      or lower(coalesce(name, '')) like '%payment thank you%'
      or lower(coalesce(name, '')) like '%credit card payment%'
      or lower(coalesce(name, '')) like '%capital one mobile pymt%'
      or lower(coalesce(name, '')) like '%electronic withdrawal capital one%'
      or lower(coalesce(name, '')) like '%mobile banking transfer%'
      or lower(coalesce(name, '')) like '%internet banking transfer%'
      or lower(coalesce(name, '')) like '%online payment%'
      or lower(coalesce(name, '')) like '%autopay%'
      or lower(coalesce(name, '')) like '%ach payment%'
      or lower(coalesce(merchant_name, '')) like '%capital one%'
    )
)
select *
from candidate_rows
order by date desc, amount desc;

-- Optional summary before delete.
with candidate_rows as (
  select id
  from public.transactions
  where plaid_transaction_id is not null
    and (
      amount <= 0
      or lower(coalesce(category, '')) like '%transfer%'
      or lower(coalesce(category, '')) like '%loan%'
      or lower(coalesce(name, '')) like '%transfer%'
      or lower(coalesce(name, '')) like '%payment thank you%'
      or lower(coalesce(name, '')) like '%credit card payment%'
      or lower(coalesce(name, '')) like '%capital one mobile pymt%'
      or lower(coalesce(name, '')) like '%electronic withdrawal capital one%'
      or lower(coalesce(name, '')) like '%mobile banking transfer%'
      or lower(coalesce(name, '')) like '%internet banking transfer%'
      or lower(coalesce(name, '')) like '%online payment%'
      or lower(coalesce(name, '')) like '%autopay%'
      or lower(coalesce(name, '')) like '%ach payment%'
      or lower(coalesce(merchant_name, '')) like '%capital one%'
    )
)
select count(*) as rows_to_delete
from candidate_rows;

-- Delete after preview/verification.
-- Uncomment to execute.
--
-- begin;
--
-- with candidate_rows as (
--   select id
--   from public.transactions
--   where plaid_transaction_id is not null
--     and (
--       amount <= 0
--       or lower(coalesce(category, '')) like '%transfer%'
--       or lower(coalesce(category, '')) like '%loan%'
--       or lower(coalesce(name, '')) like '%transfer%'
--       or lower(coalesce(name, '')) like '%payment thank you%'
--       or lower(coalesce(name, '')) like '%credit card payment%'
--       or lower(coalesce(name, '')) like '%capital one mobile pymt%'
--       or lower(coalesce(name, '')) like '%electronic withdrawal capital one%'
--       or lower(coalesce(name, '')) like '%mobile banking transfer%'
--       or lower(coalesce(name, '')) like '%internet banking transfer%'
--       or lower(coalesce(name, '')) like '%online payment%'
--       or lower(coalesce(name, '')) like '%autopay%'
--       or lower(coalesce(name, '')) like '%ach payment%'
--       or lower(coalesce(merchant_name, '')) like '%capital one%'
--     )
-- )
-- delete from public.transactions
-- where id in (select id from candidate_rows);
--
-- commit;
