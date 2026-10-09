# ADR-0018 — `person` is the identity root; Better Auth's `user` is an authentication detail

**Status:** Accepted · **Date:** 2026-10-09
**Resolves:** a gap surfaced while implementing [ADR-0017](0017-session-is-identity-not-tenant-scoped.md)
**Relates to:** [ADR-0007](0007-better-auth-self-hosted.md), [ADR-0011](0011-composite-foreign-keys-for-tenancy.md)

## The gap

`packages/db` (Phase 0, tenancy spine) models people as:

```
person(id, external_ref, archived_at)
  └── identity(id, person_id, method, identifier, verified_at)
        UNIQUE (method, identifier)
  └── org_membership(org_id, person_id, status)
  └── role_assignment(org_id, person_id, role_key, valid_from, valid_to)
```

`packages/auth` (Phase 1, Better Auth) models them as:

```
"user"(id, name, email, emailVerified, role, twoFactorEnabled)
  └── "account"(id, userId, providerId, ...)
  └── "session"(id, sessionToken, userId, orgId, ...)
```

These are two independent identity models for the same human, and **nothing joins them.** Every
authorisation decision in the product keys on `person_id`; every authentication decision keys
on `"user"."id"`. The join does not exist.

The gap became visible only because ADR-0017 added a real control. `auth_set_active_org`
verifies an active `org_membership` row before writing `session."orgId"` — but `org_membership`
keys on `person_id`, while `"session"."userId"` references `"user"."id"`. The function cannot
execute. Rather than fake it, the package asserts the observable behaviour (the call fails
loudly and writes nothing) and **throws if `org_membership` ever appears in the auth test
database**, instructing replacement with a real membership pair.

That is a fail-closed stub, not a working control. It is recorded here because it was found by
an agent rather than designed, and the honest conclusion is that this was a gap in Phase 0 that
Phase 1 has now made impossible to ignore.

## Two candidate resolutions

**Option A — `person` is a projection of `"user"`.** Add `user_id` to `person`, populated by a
sync hook whenever a Better Auth user is created. One identity, two tables, kept in step by
application code.

Rejected. It makes an externally-owned table the root of the domain model, and introduces a
synchronisation dependency that can silently drift. Every domain table would then depend on
Better Auth's lifecycle, which is exactly the coupling ADR-0007 chose to avoid by keeping
auth self-hosted and replaceable.

**Option B — `"user"` is a login alias for a `person`.** Introduce a linkage table, and make
`person` the root that authorisation already assumes.

Adopted.

## Decision

**`person` is the identity root.** It is the subject of membership, roles, contracts and
payments, and it exists independently of any authentication provider.

**Better Auth's `"user"` is an authentication detail**: a credential set by which a person
proves who they are. One person may have several. A person may have none — a player invited by
a manager and never issued a login is still a `person` with a membership, and must still be
assignable, payable and rosterable.

A new linkage table binds them, with `person_id` as the domain-side key:

```
person_credential_link
  person_id   uuid NOT NULL REFERENCES person(id) ON DELETE RESTRICT
  user_id     uuid NOT NULL REFERENCES "user"(id) ON DELETE CASCADE
  linked_at   timestamptz NOT NULL DEFAULT now()
  PRIMARY KEY (person_id, user_id)
```

Rules that make this hold rather than merely exist:

1. **A `person` with no link is legitimate.** No link means no login. Nothing in the product
   requires a human to authenticate in order to be rostered or paid.
2. **A `"user"` with no link may not transact.** Such a session resolves to no `person`, so
   `org_membership` cannot be satisfied and `auth_set_active_org` fails closed. This is the
   control ADR-0017 requires, and it is now enforceable.
3. **Linking is a privileged, audited act.** Creating the first link for a person is an
   `authentication.link_created` event in the audit taxonomy, because it is the moment an
   unloginable person becomes reachable.
4. **`ON DELETE CASCADE` from `"user"`, `RESTRICT` from `person`.** Losing a credential must
   not delete a person; deleting a person must not orphan a credential silently.

## Consequences

**Positive**
- The two models stop competing for the same meaning.
- `org_membership` and `role_assignment` keep keying on `person_id`, which is what the
  composite-FK tenancy design (ADR-0011) already assumes.
- Swapping the auth provider becomes a change to the linkage table rather than to every domain
  table.
- Invite-and-activate, the normal esports onboarding path, works without manufacturing a
  throwaway login.

**Negative**
- Every request now resolves `user → person` before authorisation can begin. That is one extra
  indexed lookup on the hot path, and it must be cached per request rather than per query.
- Linking is a new failure mode: two `"user"` rows accidentally linked to one person would
  grant the union of their reach. A partial unique index on `user_id` is required to make that
  impossible, not merely unlikely.
- Migration is required: `auth_set_active_org` and the 171 passing auth tests currently rely on
  the stub. Until it lands, that control does not execute.

## What must be built next

1. `person_credential_link` in a new migration, with the partial unique index on `user_id`.
2. RLS enabled **and forced**, tenant predicate first, failing closed — consistent with
   ADR-0015.
3. A request-scoped resolver `resolvePersonId(userId)` used by the auth-to-domain boundary.
4. Replacement of the throwing stub with a real membership / no-membership test pair.
5. A cross-package conformance test asserting that every domain authorisation path resolves
   through the link, so a new endpoint cannot skip it.

Item 5 is the one that matters. The duplicate identity model survived to this point precisely
because nothing forced the two packages to agree, and a test that spans both is the only thing
that will keep them agreeing.