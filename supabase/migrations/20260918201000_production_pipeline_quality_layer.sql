create table if not exists public.production_runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  workflow_id uuid references public.workflows(id) on delete cascade,
  content_id uuid references public.content(id) on delete cascade,
  status text not null default 'draft',
  brief jsonb not null default '{}'::jsonb,
  current_stage text,
  attempt_count integer not null default 0,
  max_attempts integer not null default 2,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists production_runs_user_created_idx on public.production_runs(user_id,created_at desc);
create index if not exists production_runs_workflow_idx on public.production_runs(workflow_id);
create index if not exists production_runs_content_idx on public.production_runs(content_id);
create table if not exists public.production_stage_outputs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  production_run_id uuid not null references public.production_runs(id) on delete cascade,
  stage text not null,
  output jsonb not null default '{}'::jsonb,
  provider text,
  model text,
  latency_ms integer,
  estimated_cost numeric(12,6),
  attempt integer not null default 1,
  status text not null default 'COMPLETED',
  created_at timestamptz not null default now()
);
create index if not exists production_stage_outputs_run_idx on public.production_stage_outputs(production_run_id,created_at);
create index if not exists production_stage_outputs_user_idx on public.production_stage_outputs(user_id,created_at desc);
create table if not exists public.quality_reviews (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  production_run_id uuid not null references public.production_runs(id) on delete cascade,
  component text not null default 'project',
  status text not null default 'FAIL',
  overall_score numeric(5,2),
  factual_confidence numeric(5,2),
  audio_quality numeric(5,2),
  visual_relevance numeric(5,2),
  platform_fit numeric(5,2),
  issues jsonb not null default '[]'::jsonb,
  required_improvements jsonb not null default '[]'::jsonb,
  recommendations jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists quality_reviews_run_idx on public.quality_reviews(production_run_id,created_at desc);
create index if not exists quality_reviews_user_idx on public.quality_reviews(user_id,created_at desc);
alter table public.production_runs enable row level security;
alter table public.production_stage_outputs enable row level security;
alter table public.quality_reviews enable row level security;
create policy production_runs_owner_all on public.production_runs for all to authenticated using (user_id=auth.uid()) with check (user_id=auth.uid());
create policy production_stage_outputs_owner_all on public.production_stage_outputs for all to authenticated using (user_id=auth.uid()) with check (user_id=auth.uid());
create policy quality_reviews_owner_all on public.quality_reviews for all to authenticated using (user_id=auth.uid()) with check (user_id=auth.uid());
create or replace function public.set_production_run_updated_at() returns trigger language plpgsql security invoker set search_path=public as $$ begin new.updated_at=now(); return new; end; $$;
create trigger production_runs_updated_at before update on public.production_runs for each row execute function public.set_production_run_updated_at();