-- Keep the external-action approval gate migration synchronized with production.
create or replace function public.enforce_external_action_approval()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  approved boolean;
begin
  if new.content_id is null then
    raise exception 'EXTERNAL_ACTION_REQUIRES_CONTENT';
  end if;
  select exists (
    select 1
    from public.approvals a
    where a.user_id = new.user_id
      and a.content_id = new.content_id
      and upper(coalesce(a.status,'')) = 'APPROVED'
      and (
        a.action is null
        or lower(a.action) in ('publish','schedule','publishing','external_publish','external')
        or lower(a.action) like '%publish%'
        or lower(a.action) like '%schedule%'
      )
  ) into approved;
  if not approved then
    raise exception 'EXTERNAL_ACTION_REQUIRES_APPROVAL';
  end if;
  return new;
end;
$$;

alter function public.enforce_external_action_approval() set search_path = public;
revoke all on function public.enforce_external_action_approval() from public, anon, authenticated;

drop trigger if exists enforce_scheduled_post_approval on public.scheduled_posts;
create trigger enforce_scheduled_post_approval
before insert or update on public.scheduled_posts
for each row execute function public.enforce_external_action_approval();

drop trigger if exists enforce_published_post_approval on public.published_posts;
create trigger enforce_published_post_approval
before insert or update on public.published_posts
for each row execute function public.enforce_external_action_approval();
