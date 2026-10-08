# ADR-0006 — Application connects as a non-superuser so RLS actually applies

**Status:** Accepted
**Date:** 2026-10-09

## Context

Row Level Security is the tenancy boundary for this product. Every tenant-owned table has
RLS enabled and forced, and every policy resolves the tenant first. If the application
connects as a database superuser, **every RLS policy is silently bypassed** and the entire
isolation model is theatre while appearing to work.

This is not a hypothetical. The legacy system had policies written and — according to
`database/README.md` — deliberately disabled during development, so the code was built
and tested against a database with no row-level enforcement. Numerous code paths "worked"
because of that, and would have opened up the moment RLS was enabled.

## Decision

Two distinct roles:

| Role | Superuser | Used by | Purpose |
| --- | --- | --- | --- |
| `raptor_migrator` | yes | migrations only | Owns the schema, DDL, RLS policy creation |
| `raptor_app` | **no**, `NOBYPASSRLS` | the running application | Every query in the product |

The application role is granted only the specific DML privileges it needs. No credential
for the migration role is ever present in an application environment.

## Verification

This was proven empirically before adoption, not assumed. Running as superuser:

```
org-a sees: [ 'org-a-data', 'org-b-data' ]   ← isolation silently absent
org-b sees: [ 'org-a-data', 'org-b-data' ]   ← isolation silently absent
```

Running the identical queries as `app_user LOGIN NOSUPERUSER NOBYPASSRLS`:

```
org-a sees: [ 'org-a-data' ]
org-b sees: [ 'org-b-data' ]
```

The first output is the failure mode this ADR exists to prevent: it looks like working
software while no isolation exists.

## Consequences

**Positive**
- RLS is a real boundary, continuously exercised by every integration test.
- A stray `SELECT *` in application code cannot leak another tenant's rows.
- The migration role is unavailable to the app, so a compromised application process
  cannot alter its own security policies.

**Negative**
- Privileges must be granted deliberately per table. New tables without grants fail
  loudly — which is the correct failure direction.
- Some privileged operations cannot be done by the app role and require narrowly scoped
  `SECURITY DEFINER` functions with an explicit `SET search_path` and
  `REVOKE … FROM PUBLIC`. This is intended.
- Integration tests must connect twice (owner to set up, app role to assert), which is
  a little more setup and is exactly the point.