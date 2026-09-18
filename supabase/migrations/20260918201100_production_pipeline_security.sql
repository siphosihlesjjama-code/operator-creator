-- Security/performance hardening for the production pipeline.
create index if not exists production_runs_content_idx on public.production_runs(content_id);
alter function public.set_production_run_updated_at() set search_path=public;