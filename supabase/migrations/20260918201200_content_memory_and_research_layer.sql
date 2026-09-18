create table if not exists public.content_memory (
 id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users(id) on delete cascade,
 content_id uuid references public.content(id) on delete cascade, production_run_id uuid references public.production_runs(id) on delete cascade,
 memory_type text not null, topic text, fingerprint text, data jsonb not null default '{}'::jsonb, created_at timestamptz not null default now()
);
create index if not exists content_memory_user_idx on public.content_memory(user_id,created_at desc);
create index if not exists content_memory_fingerprint_idx on public.content_memory(user_id,fingerprint);
alter table public.content_memory enable row level security;
create policy content_memory_owner_all on public.content_memory for all to authenticated using (user_id=auth.uid()) with check (user_id=auth.uid());

create table if not exists public.research_sources (
 id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users(id) on delete cascade,
 production_run_id uuid not null references public.production_runs(id) on delete cascade, title text, url text, source_type text,
 claim text, verified boolean not null default false, data jsonb not null default '{}'::jsonb, created_at timestamptz not null default now()
);
create index if not exists research_sources_run_idx on public.research_sources(production_run_id,created_at);
alter table public.research_sources enable row level security;
create policy research_sources_owner_all on public.research_sources for all to authenticated using (user_id=auth.uid()) with check (user_id=auth.uid());