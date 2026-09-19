REVOKE SELECT, INSERT, UPDATE, REFERENCES ON public.social_accounts FROM anon, authenticated;
GRANT SELECT (id,user_id,platform,external_account_id,display_name,status,scopes,metadata,created_at,updated_at) ON public.social_accounts TO authenticated;
GRANT INSERT (user_id,platform,external_account_id,display_name,status,scopes,metadata) ON public.social_accounts TO authenticated;
GRANT UPDATE (platform,external_account_id,display_name,status,scopes,metadata) ON public.social_accounts TO authenticated;
GRANT ALL ON public.social_accounts TO service_role;
