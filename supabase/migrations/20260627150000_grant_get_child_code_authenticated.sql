-- ============================================================================
-- get_child_code(uuid) was missing its EXECUTE grant to authenticated on the
-- live project (the function existed, but parents got a permission-denied
-- error calling it from the dashboard's "Show code" button). This re-asserts
-- the grant; safe to run even if it's already in place.
-- ============================================================================

grant execute on function public.get_child_code(uuid) to authenticated;
