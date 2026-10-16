-- =============================================================================
-- 0015 — cms_operator_session: Better Auth session → CMS operator (Task 9)
-- =============================================================================
--
-- WHY THIS FUNCTION EXISTS
-- ------------------------
-- Payload's admin/API authenticates CMS operators, but product identity lives
-- in Better Auth (`auth_user` + `auth_session`). A second password system for
-- CMS access would be a second identity model — the exact defect class this
-- repository exists to remove. This function is the single bridge: given a
-- session token the caller ALREADY HOLDS, it returns the matching CMS
-- operator row, or nothing.
--
-- RULES ENFORCED INSIDE (not in the caller, which cannot be trusted to):
--   1. The session must exist and be unexpired.
--   2. The product email must be verified (matches requireEmailVerification).
--   3. A cms_operators row with the same email must exist (case-insensitive).
-- MFA is NOT decided here: the function also returns the product role and
-- TOTP state so the strategy applies `evaluateMfaRequirement` itself, in one
-- place, tested without a database.
--
-- PRIVILEGE
-- ---------
-- SECURITY DEFINER (reads `auth_user`, which `cms_app` cannot read directly)
-- with a pinned empty search_path (ADR-0006 pattern), EXECUTE revoked from
-- PUBLIC and granted to `cms_app` alone. Threat model mirrors
-- `auth_session_by_token`: the token is the credential, and only its holder
-- can resolve it — to their own operator row and nothing else.
--
-- ORDERING
-- --------
-- References `auth_*` (packages/auth) and `cms_operators` (Payload migrate).
-- plpgsql bodies are checked at first CALL, not at CREATE, so this applies
-- cleanly before either exists; calls fail loudly until both do.
-- =============================================================================

-- SELF-SUFFICIENCY
-- ----------------
-- `GRANT ... TO cms_app` below fails when the role does not exist, and the
-- PGlite test harness applies every canonical migration without running
-- `packages/cms/provision.sql`. So the role is created here when missing
-- (same precedent as `raptor_app` in 0001), with no password and no grants
-- beyond existence: passwords and table ownership stay in provision.sql,
-- which remains the production path and is a no-op for an existing role.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cms_app') THEN
    CREATE ROLE cms_app LOGIN
      NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION public.cms_operator_session(p_token text)
RETURNS TABLE (
  operator_id  integer,
  email        text,
  cms_role     text,
  product_role text,
  product_mfa  boolean
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id  uuid;
  v_email    text;
  v_verified boolean;
  v_role     text;
  v_mfa      boolean;
BEGIN
  SELECT s."userId"
    INTO v_user_id
    FROM public."auth_session" s
   WHERE s."token" = p_token
     AND s."expiresAt" > now();

  IF v_user_id IS NULL THEN
    RETURN;
  END IF;

  SELECT u."email", u."emailVerified", u."role", u."twoFactorEnabled"
    INTO v_email, v_verified, v_role, v_mfa
    FROM public."auth_user" u
   WHERE u."id" = v_user_id;

  IF v_email IS NULL OR NOT v_verified THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT o.id, o.email::text, o.role::text, v_role::text, v_mfa
    FROM public.cms_operators o
   WHERE lower(o.email) = lower(v_email);
END
$$;

REVOKE ALL ON FUNCTION public.cms_operator_session(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.cms_operator_session(text) TO cms_app;

COMMENT ON FUNCTION public.cms_operator_session(text) IS
  'Better Auth session token → CMS operator row for Payload custom auth strategy (Task 9). Empty unless the session is live, the email verified, and a cms_operators row matches. EXECUTE to cms_app only.';
