-- External actions must be approved after the current content state was last changed.
CREATE OR REPLACE FUNCTION public.enforce_external_action_approval()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=public
AS $function$
declare
  approved boolean;
  ready boolean;
begin
  if new.content_id is null then raise exception 'EXTERNAL_ACTION_REQUIRES_CONTENT'; end if;

  select exists (
    select 1
    from public.approvals a
    join public.content c on c.id=new.content_id and c.user_id=new.user_id
    where a.user_id=new.user_id
      and a.content_id=new.content_id
      and upper(coalesce(a.status,''))='APPROVED'
      and a.decided_at is not null
      and a.decided_at >= c.updated_at
      and (a.action is null or lower(a.action) like '%publish%' or lower(a.action) like '%schedule%')
  ) into approved;
  if not approved then raise exception 'EXTERNAL_ACTION_REQUIRES_CURRENT_APPROVAL'; end if;

  select exists (
    select 1
    from public.content c
    join lateral (
      select pr.status, pr.final_asset_id
      from public.production_runs pr
      where pr.user_id=new.user_id and pr.content_id=c.id
      order by pr.updated_at desc
      limit 1
    ) pr on true
    join public.assets a on a.id=pr.final_asset_id and a.user_id=new.user_id and a.status='READY'
    where c.id=new.content_id
      and c.user_id=new.user_id
      and c.status='READY'
      and pr.status='ready'
  ) into ready;
  if not ready then raise exception 'EXTERNAL_ACTION_REQUIRES_FINAL_QA'; end if;
  return new;
end;
$function$;

REVOKE EXECUTE ON FUNCTION public.enforce_external_action_approval() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.enforce_external_action_approval() TO service_role;
