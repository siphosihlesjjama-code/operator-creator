create table if not exists public.caption_tracks (
 id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users(id) on delete cascade,
 production_run_id uuid not null references public.production_runs(id) on delete cascade,
 content_id uuid references public.content(id) on delete set null, language text not null default 'en',
 format text not null default 'webvtt', status text not null default 'READY',
 cues jsonb not null default '[]'::jsonb, source text, created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index if not exists caption_tracks_run_idx on public.caption_tracks(production_run_id);
create index if not exists caption_tracks_user_idx on public.caption_tracks(user_id);
alter table public.caption_tracks enable row level security;
create policy caption_tracks_owner on public.caption_tracks for all using (user_id=auth.uid()) with check (user_id=auth.uid());

create table if not exists public.render_jobs (
 id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users(id) on delete cascade,
 production_run_id uuid not null references public.production_runs(id) on delete cascade,
 status text not null default 'QUEUED', format text not null default 'mp4',
 aspect_ratio text not null default '16:9', resolution text not null default '1080p',
 asset_id uuid references public.assets(id) on delete set null, caption_track_id uuid references public.caption_tracks(id) on delete set null,
 provider text, provider_job_id text, error_code text, metadata jsonb not null default '{}'::jsonb,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index if not exists render_jobs_run_idx on public.render_jobs(production_run_id);
create index if not exists render_jobs_user_idx on public.render_jobs(user_id);
alter table public.render_jobs enable row level security;
create policy render_jobs_owner on public.render_jobs for all using (user_id=auth.uid()) with check (user_id=auth.uid());

create table if not exists public.production_media_links (
 id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users(id) on delete cascade,
 production_run_id uuid not null references public.production_runs(id) on delete cascade,
 scene_number integer, asset_id uuid not null references public.assets(id) on delete cascade,
 role text not null default 'scene_visual', created_at timestamptz not null default now()
);
create index if not exists production_media_links_run_idx on public.production_media_links(production_run_id);
create index if not exists production_media_links_asset_idx on public.production_media_links(asset_id);
alter table public.production_media_links enable row level security;
create policy production_media_links_owner on public.production_media_links for all using (user_id=auth.uid()) with check (user_id=auth.uid());

alter table public.production_runs add column if not exists render_status text;
alter table public.production_runs add column if not exists final_asset_id uuid references public.assets(id) on delete set null;
alter table public.production_runs add column if not exists caption_track_id uuid references public.caption_tracks(id) on delete set null;