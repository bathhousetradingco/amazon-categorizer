-- Keep Amazon refresh tokens server-only. The app reads connection state through
-- the amazon-business-status Edge Function instead of selecting this table.

drop policy if exists amazon_business_connections_select_own on public.amazon_business_connections;
