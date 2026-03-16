insert into public.product_lookup (merchant, item_number, product_name, verified_by_user)
values
  ('sams_club', '744575', 'Sharpie Permanent Marker, Fine Tip, Black, 24 Count', true),
  ('sams_club', '980022771', 'Scotch Heavy Duty Shipping Packaging Tape, 1.88" x 60.15 yd, 6-Pack', true),
  ('sams_club', '990012260', 'If You Care #4 Unbleached Coffee Filter, 400 ct.', true)
on conflict (merchant, item_number) do update
set
  product_name = excluded.product_name,
  verified_by_user = true;
