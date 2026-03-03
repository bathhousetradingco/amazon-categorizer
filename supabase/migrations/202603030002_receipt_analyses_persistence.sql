create table if not exists public.receipt_analyses (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  file_path text not null,
  analysis_data jsonb not null,
  user_state jsonb not null default '{}'::jsonb,
  last_analyzed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, file_path)
);

create index if not exists receipt_analyses_user_id_idx on public.receipt_analyses(user_id);
create index if not exists receipt_analyses_file_path_idx on public.receipt_analyses(file_path);

do $$
begin
  if to_regprocedure('public.set_current_timestamp_updated_at()') is not null
     and not exists (select 1 from pg_trigger where tgname = 'set_receipt_analyses_updated_at') then
    create trigger set_receipt_analyses_updated_at
    before update on public.receipt_analyses
    for each row
    execute function public.set_current_timestamp_updated_at();
  end if;
end
$$;

alter table public.receipt_analyses enable row level security;

create policy "Users can view own receipt analyses"
on public.receipt_analyses
for select
using (auth.uid() = user_id);

create policy "Users can upsert own receipt analyses"
on public.receipt_analyses
for insert
with check (auth.uid() = user_id);

create policy "Users can update own receipt analyses"
on public.receipt_analyses
for update
using (auth.uid() = user_id)
with check (auth.uid() = user_id);
