create table if not exists public.publishing_attempts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  production_run_id uuid references public.production_runs(id) on delete set null,
  content_id uuid not null references public.content(id) on delete cascade,
  social_account_id uuid references public.social_accounts(id) on delete set null,
  platform text not null,
  idempotency_key text not null,
  attempt_number integer not null default 1,
  status text not null default 'QUEUED',
  external_post_id text,
  error_code text,
  error_message text,
  provider_response jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint publishing_attempts_status_check check (status in ('QUEUED','PROCESSING','PUBLISHED','FAILED','CANCELLED','PROVIDER_NOT_CONFIGURED')),
  constraint publishing_attempts_idempotency_unique unique (user_id,idempotency_key)
);
create index if not exists publishing_attempts_user_idx on public.publishing_attempts(user_id,created_at desc);
create index if not exists publishing_attempts_production_idx on public.publishing_attempts(production_run_id);
create index if not exists publishing_attempts_content_idx on public.publishing_attempts(content_id);
create index if not exists publishing_attempts_social_idx on public.publishing_attempts(social_account_id);
alter table public.publishing_attempts enable row level security;
drop policy if exists publishing_attempts_owner on public.publishing_attempts;
create policy publishing_attempts_owner on public.publishing_attempts for all using ((select auth.uid())=user_id) with check ((select auth.uid())=user_id);

alter table public.render_jobs add column if not exists idempotency_key text;
alter table public.render_jobs add column if not exists attempt_number integer not null default 1;
alter table public.render_jobs add column if not exists max_attempts integer not null default 3;
alter table public.render_jobs add column if not exists next_retry_at timestamptz;
alter table public.render_jobs add column if not exists provider_status text;
alter table public.render_jobs add column if not exists started_at timestamptz;
alter table public.render_jobs add column if not exists completed_at timestamptz;
alter table public.render_jobs add column if not exists last_error text;
create unique index if not exists render_jobs_idempotency_unique on public.render_jobs(user_id,idempotency_key) where idempotency_key is not null;

alter table public.scheduled_posts add column if not exists idempotency_key text;
alter table public.scheduled_posts add column if not exists updated_at timestamptz not null default now();
create unique index if not exists scheduled_posts_idempotency_unique on public.scheduled_posts(user_id,idempotency_key) where idempotency_key is not null;

alter table public.published_posts add column if not exists idempotency_key text;
alter table public.published_posts add column if not exists updated_at timestamptz not null default now();
create unique index if not exists published_posts_idempotency_unique on public.published_posts(user_id,idempotency_key) where idempotency_key is not null;

create or replace function public.set_publishing_attempt_updated_at()
returns trigger language plpgsql security definer set search_path=public as $$
begin new.updated_at=now(); return new; end; $$;
revoke all on function public.set_publishing_attempt_updated_at() from public,anon,authenticated;
drop trigger if exists publishing_attempts_updated_at on public.publishing_attempts;
create trigger publishing_attempts_updated_at before update on public.publishing_attempts for each row execute function public.set_publishing_attempt_updated_at();