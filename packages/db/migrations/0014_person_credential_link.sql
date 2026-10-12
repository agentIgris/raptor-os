-- =============================================================================
-- 0014 — person_credential_link: the join between the domain identity and the
-- login identity (ADR-0018, item 1).
-- =============================================================================
--
-- THE GAP THIS CLOSES
-- -------------------
-- `packages/db` models people as person(id) + identity + org_membership(person_id).
-- `packages/auth` (Better Auth) models them as "user"(id) + "account" + "session"(userId).
-- Nothing joined them. Every authorisation decision keys on person_id; every
-- authentication decision keys on "user".id. `auth_set_active_org` could not execute:
-- it needed an active org_membership for the session's user, and there was no path
-- from a user to a person. It failed closed, which was correct but useless.
--
-- DECISION (ADR-0018): person is the identity root. Better Auth's "user" is an
-- authentication detail — a credential set by which a person proves who they are.
-- This table binds them.
--
-- WHY NO org_id, NO RLS
-- ---------------------
-- Both sides are global: person is org-independent by design (a human may work for
-- several organisations), and "user" is likewise global. An org_id here would answer
-- "which organisation does this LOGIN belong to", which is the wrong question — the
-- login belongs to the person, and membership answers the org question per org.
-- person, identity and person_profile are likewise global and RLS-less; this table
-- follows the same precedent deliberately, not by omission.
--
-- WHY NO FOREIGN KEY TO "user"
-- -----------------------------
-- "user" is owned by packages/auth and does not exist when these migrations run
-- standalone (and must not: the domain layer cannot depend on the auth provider's
-- lifecycle — that coupling is what ADR-0007 exists to avoid). A REFERENCES clause
-- to a table that may not exist would make this migration unappliable. So:
--   - person_id REFERENCES person(id) ON DELETE RESTRICT (losing a credential must
--     not delete a person; deleting a person must not orphan a credential silently).
--   - user_id is a bare uuid with UNIQUE(user_id): one credential resolves to at most
--     one person. Two "user" rows linked to one person would grant the union of their
--     reach, so the uniqueness is the load-bearing constraint.
-- Orphan user_ids (a "user" row deleted while its link survives) resolve to a person
-- with no credential — which reads as "no login", the safe direction.
--
-- PRIVILEGE
-- ---------
-- No grant to raptor_app. Linking is a privileged, audited act (ADR-0018 rule 3:
-- creating the first link for a person is an authentication.link_created event),
-- performed through the migration/owner path. `auth_set_active_org` reads this table
-- as its SECURITY DEFINER owner, so it needs no grant to function.
-- THAT IS LOAD-BEARING, NOT INCIDENTAL: if a future migration grants DML here to an
-- application role, the membership check becomes bypassable by link forgery.

CREATE TABLE IF NOT EXISTS person_credential_link (
  person_id   uuid        NOT NULL REFERENCES person(id) ON DELETE RESTRICT,
  user_id     uuid        NOT NULL,
  linked_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT person_credential_link_pkey PRIMARY KEY (person_id, user_id),
  CONSTRAINT person_credential_link_user_id_key UNIQUE (user_id)
);

COMMENT ON TABLE person_credential_link IS
  'Binds a domain person to a Better Auth "user" (ADR-0018). person is the identity root; "user" is a credential set. A person with no link is legitimate (invited, never issued a login) and remains rosterable and payable. A "user" with no link may not transact: membership cannot be satisfied without a person, so auth_set_active_org fails closed. Deliberately NOT exported by portability_export_contract(): a credential binding is authentication material, not business data — re-importing it elsewhere would point at user rows that do not exist there, or worse at a different human''s login. Like identity, links are re-established by re-authentication, never by transfer.';

COMMENT ON CONSTRAINT person_credential_link_user_id_key ON person_credential_link IS
  'One credential resolves to at most one person. Without this, two "user" rows linked to one person would grant the union of their reach.';

-- Self-guardianship of the constraint set: the link table must never become a
-- second identity model. A display name, an email, a credential hash or anything
-- that answers "who is this human" belongs on person/person_profile or on "user",
-- never here. Enforced by inspection, not by DDL — but stated so the next column
-- addition has to argue with this comment first.
