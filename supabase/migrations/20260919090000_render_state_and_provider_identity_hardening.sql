-- Production hardening: constrain render state and provider job identity.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname='render_jobs_status_check'
      AND conrelid='public.render_jobs'::regclass
  ) THEN
    ALTER TABLE public.render_jobs
      ADD CONSTRAINT render_jobs_status_check
      CHECK (status = ANY (ARRAY[
        'QUEUED','PROCESSING','COMPLETED','FAILED','PROVIDER_NOT_CONFIGURED','TIMEOUT','CANCELLED'
      ]));
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS render_jobs_provider_job_id_unique
  ON public.render_jobs(provider, provider_job_id)
  WHERE provider IS NOT NULL AND provider_job_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS render_jobs_retry_due_idx
  ON public.render_jobs(user_id, next_retry_at)
  WHERE status='QUEUED' AND next_retry_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS render_jobs_provider_status_idx
  ON public.render_jobs(provider, provider_status)
  WHERE provider_job_id IS NOT NULL;
