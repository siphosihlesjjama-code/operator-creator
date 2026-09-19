create or replace function public.enforce_external_action_approval()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare approved boolean; ready boolean;
begin
  if new.content_id is null then raise exception 'EXTERNAL_ACTION_REQUIRES_CONTENT'; end if;
  select exists (
    select 1 from public.approvals a
    where a.user_id=new.user_id and a.content_id=new.content_id
      and upper(coalesce(a.status,''))='APPROVED'
      and (a.action is null or lower(a.action) like '%publish%' or lower(a.action) like '%schedule%')
  ) into approved;
  if not approved then raise exception 'EXTERNAL_ACTION_REQUIRES_APPROVAL'; end if;
  select exists (
    select 1
    from public.content c
    join lateral (
      select pr.status,pr.final_asset_id
      from public.production_runs pr
      where pr.user_id=new.user_id and pr.content_id=c.id
      order by pr.updated_at desc limit 1
    ) pr on true
    join public.assets a on a.id=pr.final_asset_id and a.user_id=new.user_id and a.status='READY'
    where c.id=new.content_id and c.user_id=new.user_id and c.status='READY' and pr.status='ready'
  ) into ready;
  if not ready then raise exception 'EXTERNAL_ACTION_REQUIRES_FINAL_QA'; end if;
  return new;
end;
$$;
alter function public.enforce_external_action_approval() set search_path=public;
revoke all on function public.enforce_external_action_approval() from public,anon,authenticated;