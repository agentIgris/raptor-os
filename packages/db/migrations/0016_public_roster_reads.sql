-- =============================================================================
-- 0016 — public roster reads: service-layer handles (staging content job)
-- =============================================================================
--
-- WHY THESE FUNCTIONS EXIST
-- -------------------------
-- `person_profile` carries RLS with NO policy (0001): no policy means no rows
-- for `raptor_app`, ever — contact and identity data must never be reachable
-- from the application role directly. 0001 states access is "gated in the
-- service layer by membership", and these two functions ARE that gate: they
-- run as the owner (SECURITY DEFINER, pinned empty search_path) and expose
-- exactly display names, nothing that identifies a human off-platform
-- (no legal names: those live in no column selected here; no contact data,
-- no credential material).
--
-- SCOPE OF EACH ROW
-- ------------------
-- `roster_handles()` returns current team memberships with the handle left
-- NULL when no profile exists. Callers decide visibility: the public site
-- keeps `visibility = 'public'` rows only; the workspace shows all handles
-- to members. `person_directory()` returns one row per non-departed member
-- of the CURRENT tenant only (never a global person list).
--
-- Tenant always comes from the session (`current_org_id()`, ADR-0011 rule 3):
-- neither function takes an org argument, so no caller can aim them at
-- another tenant. EXECUTE is revoked from PUBLIC and granted to `raptor_app`
-- alone.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.roster_handles()
RETURNS TABLE (
  team_slug    text,
  handle       text,
  visibility   text,
  role_in_team text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT t.slug::text,
         pp.display_name::text,
         pp.profile_visibility::text,
         tm.role_in_team::text
    FROM public.team t
    JOIN public.team_membership tm
      ON tm.team_id = t.id
     AND tm.valid_to IS NULL
    LEFT JOIN public.person_profile pp
      ON pp.person_id = tm.person_id
   WHERE t.org_id = public.current_org_id()
     AND t.archived_at IS NULL
     AND t.is_active
$$;

CREATE OR REPLACE FUNCTION public.person_directory()
RETURNS TABLE (
  person_id  uuid,
  handle     text,
  visibility text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT m.person_id,
         pp.display_name::text,
         pp.profile_visibility::text
    FROM public.org_membership m
    LEFT JOIN public.person_profile pp
      ON pp.person_id = m.person_id
   WHERE m.org_id = public.current_org_id()
     AND m.status <> 'left'
$$;

REVOKE ALL ON FUNCTION public.roster_handles() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.roster_handles() TO raptor_app;

REVOKE ALL ON FUNCTION public.person_directory() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.person_directory() TO raptor_app;

COMMENT ON FUNCTION public.roster_handles() IS
  'Service-layer roster read: current team memberships with display handles (NULL when no profile). Callers filter visibility; the function itself exposes no contact, legal-name or credential data. EXECUTE to raptor_app only.';
COMMENT ON FUNCTION public.person_directory() IS
  'Service-layer member directory: one row per non-departed member of the session tenant with display handle. EXECUTE to raptor_app only.';
