# ADR-0011 — Every tenant foreign key includes `org_id`

**Status:** Accepted · **Date:** 2026-10-09

## Context

Multi-tenancy is this product's foundation; the legacy system had no `organization_id`
anywhere, which the audit called the single most consequential fact in the review.

The standard approach — put `org_id` on every table and scope every query with it — relies
on every query remembering to filter. One forgotten predicate is a cross-tenant data leak,
and nothing in the type system or the ORM catches it.

## Decision

**Every foreign key between tenant-owned tables is composite and includes `org_id`.**

```sql
CONSTRAINT child_tenant_fk FOREIGN KEY (org_id, tenant_id)
  REFERENCES tenant (org_id, id)
```

This requires every referenced table to carry `UNIQUE (org_id, id)`.

Cross-tenant references become **structurally impossible** rather than merely discouraged:
the referenced row cannot exist in the other tenant, so the insert fails.

## Verification

Executed against the local database before adoption:

```
cross-tenant FK rejected: violates foreign key constraint "child_tenant_fk"
same-tenant FK accepted: OK
```

## Consequences

**Positive**
- A cross-tenant foreign key cannot be created even by a careless developer.
- RLS and FK constraints agree — one says "you may not see it", the other says "it cannot
  be referenced".
- This is the mechanism that makes "no tenant may reference another tenant" a property of
  the schema rather than of code review discipline.

**Negative**
- Every referenced table needs `UNIQUE (org_id, id)`, even where `id` alone is already a
  primary key. Some redundancy in the index set; accepted deliberately.
- Composite joins are slightly more verbose.
- A migration that forgets `org_id` in a foreign key is a silent isolation hole. Mitigated
  by a schema-conformance test that reflects every FK and asserts the composite form — see
  ADR-0012.

## Companion rules

1. `org_id NOT NULL` on every tenant-owned table.
2. Composite index **leads** with `org_id`, e.g. `(org_id, created_at)`.
3. The tenant is resolved from the **session**, never a request parameter — otherwise the
   caller chooses which tenant they act in.
4. Cross-tenant access returns **404, not 403**, so existence is never confirmed.