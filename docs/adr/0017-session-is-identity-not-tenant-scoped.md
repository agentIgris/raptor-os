# ADR-0017 — `session` is an identity record, not a tenant-scoped one

**Status:** Accepted · **Date:** 2026-10-09
**Amends:** `packages/auth/src/schema.sql`, `packages/auth/src/config.ts`
**Relates to:** [ADR-0015](0015-pglite-restored-after-native-postgres-retest.md), [ADR-0006](0006-non-superuser-application-role.md)

## The defect

`packages/auth` forces RLS on Better Auth's `session` table, with:

```sql
CREATE POLICY session_tenant_isolation ON "session"
  USING      (current_org_id() IS NOT NULL AND "orgId" = current_org_id()::text)
  WITH CHECK (current_org_id() IS NOT NULL AND "orgId" = current_org_id()::text);
```

This policy replaced an earlier version whose `current_org_id() IS NULL` branch exposed every
tenant's sessions at once — a real cross-tenant credential-store leak, and correcting it was
correct.

But the replacement makes **sign-in impossible**. The session's `orgId` field is declared
`required: false, input: false`, so Better Auth inserts `NULL`. The `WITH CHECK` clause
requires `"orgId" = current_org_id()::text`. With `"orgId" IS NULL` that comparison is `NULL`,
which is not true, so every session insert is rejected:

```
code=42501  new row violates row-level security policy for table "session"
```

Fourteen tests were failing for exactly this reason. The code comment claimed Better Auth
"replaces it with the default (absent) on create" — **no default is ever set anywhere in the
package.**

This is not a test-fixture problem. Production sign-in is broken.

## Why the policy cannot simply be satisfied

The circle is unavoidable as specified:

1. Resolving which tenant a request belongs to requires reading the session.
2. Reading the session requires RLS, which requires knowing the tenant.

The earlier policy broke the circle by failing **open** (see above). Failing **closed** breaks
it by refusing to let any session exist. Both are symptoms of the same mistake: treating the
session as the tenant-scoped record when it is in fact the identity record that *establishes*
the tenant.

## Decision

**The `session` table is identity, and carries no tenant RLS policy.** Tenant isolation is
enforced where tenancy actually lives: `org_membership` and every business table, through
forced RLS plus the policy engine in `packages/core/src/authorization`.

This is consistent with the rest of the Better Auth schema. `user`, `account`, `verification`
and `twoFactor` have never been tenant-scoped, and rightly so — a human may work for several
organisations, so an `org_id` predicate on the identity tables would be meaningless rather
than merely redundant. `session` sat in exactly that same category and was the sole exception.

`session.orgId` is retained, with a narrowed meaning: it is the **active organisation** chosen
for this session. It remains server-only (`input: false`), and it is no longer a boundary.

### Consequences

**Positive**
- Sign-in works.
- The fail-open branch is gone and is not being reintroduced under another name.
- Multi-organisation users work naturally, because the active org is a value, not a partition.
- No chicken-and-egg bootstrap query with elevated privilege.

**Negative — stated plainly**
- A request can read a session row belonging to another tenant. That is accepted and is *not*
  claimed to be prevented. The session holds a token and identity metadata, not business data.
- The fail-closed property is now asserted on `org_membership` and the business tables rather
  than on `session`.

**Compensating controls, which must exist for this to be acceptable**
1. `orgId` stays `input: false`. A client can never assert its own tenant through Better Auth.
2. Setting the active org requires a server-side check of an active `org_membership` row. A
   user cannot bind a session to an organisation they do not belong to.
3. Every business query is gated by forced RLS on tenant tables *and* by the policy engine's
   `roleAssignment` lookup. Possessing a session with a forged `orgId` confers no permission,
   because authorisation is resolved against real assignments rather than trusted from the
   token.
4. A test must assert exactly that: a session carrying another organisation's `orgId` grants
   nothing. Without it this ADR is an unverified claim.

## Why not require the org at sign-in instead

The alternative was making `orgId` required and having the client state which organisation it
is signing into, so the server could validate membership *before* creating the session. That
preserves a tenant predicate on `session` and is genuinely stronger.

It was rejected because it couples authentication to tenant selection, forces a user who
belongs to three organisations to choose before they can authenticate, and makes every future
change to the sign-in flow a change to the tenancy model. Session tables are identity records
in essentially every multi-tenant system for the same reason. The stronger option can be
adopted later without rework, because `orgId` is already present and already server-only.

## Record-keeping

The previous policy is not preserved by a comment claiming it worked. The earlier
`current_org_id() IS NULL` variant, which leaked every tenant's sessions, and this one, which
blocks all sign-in, are both wrong in the same way.