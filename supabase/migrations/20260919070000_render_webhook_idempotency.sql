create table if not exists public.render_webhook_events (
 id uuid primary key default gen_random_uuid(),
 provider text not null,
 event_type text not null,
 action text not null,
 event_id text not null,
 render_job_id uuid references public.render_jobs(id) on delete set null,
 status text not null default 'PROCESSING' check (status in ('PROCESSING','COMPLETED','FAILED')),
 attempt_count integer not null default 1 check (attempt_count > 0),
 payload jsonb,
 error_message text,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 completed_at timestamptz
);
create unique index if not exists render_webhook_events_unique on public.render_webhook_events(provider,event_type,action,event_id);
create index if not exists render_webhook_events_job_idx on public.render_webhook_events(render_job_id);
create index if not exists render_webhook_events_status_idx on public.render_webhook_events(status,updated_at);
alter table public.render_webhook_events enable row level security;
drop policy if exists render_webhook_events_owner_select on public.render_webhook_events;
create policy render_webhook_events_owner_select on public.render_webhook_events for select to authenticated using ((select auth.uid()) = (select user_id from public.render_jobs r where r.id = render_job_id));
create or replace function public.set_render_webhook_event_updated_at() returns trigger language plpgsql security definer set search_path=public as $$
begin new.updated_at=now(); return new; end $$;
revoke execute on function public.set_render_webhook_event_updated_at() from public,anon,authenticated;
drop trigger if exists render_webhook_events_updated_at on public.render_webhook_events;
create trigger render_webhook_events_updated_at before update on public.render_webhook_events for each row execute function public.set_render_webhook_event_updated_at();