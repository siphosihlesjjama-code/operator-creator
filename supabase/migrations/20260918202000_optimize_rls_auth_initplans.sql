-- Optimize RLS policies so auth.uid() is evaluated once per statement.
DO $$
DECLARE
  p record;
  new_using text;
  new_check text;
BEGIN
  FOR p IN
    SELECT schemaname, tablename, policyname, qual, with_check
    FROM pg_policies
    WHERE schemaname='public'
      AND (coalesce(qual,'') LIKE '%auth.uid()%' OR coalesce(with_check,'') LIKE '%auth.uid()%')
  LOOP
    new_using := CASE WHEN p.qual IS NULL THEN NULL ELSE replace(p.qual, 'auth.uid()', '(select auth.uid())') END;
    new_check := CASE WHEN p.with_check IS NULL THEN NULL ELSE replace(p.with_check, 'auth.uid()', '(select auth.uid())') END;
    EXECUTE format(
      'ALTER POLICY %I ON %I.%I %s %s',
      p.policyname, p.schemaname, p.tablename,
      CASE WHEN new_using IS NOT NULL THEN 'USING (' || new_using || ')' ELSE '' END,
      CASE WHEN new_check IS NOT NULL THEN 'WITH CHECK (' || new_check || ')' ELSE '' END
    );
  END LOOP;
END $$;