insert into public.product_lookup (merchant, item_number, product_name, verified_by_user)
values
  ('sams_club', '980066417', 'Member''s Mark Premium Cane Sugar, 25 lbs.', true)
on conflict (merchant, item_number) do update
set
  product_name = excluded.product_name,
  verified_by_user = true;
