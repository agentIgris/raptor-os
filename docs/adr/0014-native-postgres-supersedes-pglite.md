# ADR-0014 — Native PostgreSQL 18.6 is the local database; supersedes ADR-0002

**Status:** Accepted · **Date:** 2026-10-09
**Supersedes:** [ADR-0002](0002-local-postgres-via-pglite.md)

## Context

ADR-0002 adopted PGlite after native PostgreSQL repeatedly failed on this machine. The
recorded diagnosis was antivirus interference: McAfee was installed alongside Windows
Defender, and every forked child process died with `0xC0000142` while single-process
commands worked. PostgreSQL's own log suggested the same cause.

McAfee has since been uninstalled.

## Decision

Use **native PostgreSQL 18.6** as the local development and test database. PGlite is
retained only as an optional in-memory mode for fast unit tests that do not need a server.

## Verification

Retried immediately after the McAfee removal:

```
$ psql -U postgres -h 127.0.0.1 -p 5432 -d postgres -tAc "select 'CONNECTED :: ' || version();"
CONNECTED :: PostgreSQL 18.6 on x86_64-windows, compiled by msvc-19.44.35229, 64-bit
```

Nine `postgres` processes stay alive across a client connection — the child processes that
previously died on creation now survive. The `0xC0000142` failure is gone. **McAfee was the
cause, confirmed by elimination.**

The migration applies cleanly against native PostgreSQL: 17 tables, 8 with RLS enabled **and
forced**.

## Tenant isolation proven on real PostgreSQL

The security property that justifies the whole tenancy design, demonstrated with one
identical query under two roles:

```
-- seeded: two organisations, one membership each

-- as raptor_migrator (SUPERUSER), app.org_id = org A
11111111-1111-1111-1111-111111111111     <- org A
22222222-2222-2222-2222-222222222222     <- org B  LEAKED

-- as raptor_app (NOSUPERUSER), app.org_id = org A
11111111-1111-1111-1111-111111111111     <- org A only
```

As a superuser the tenant context is ignored and **both** tenants are returned. This is the
precise failure that makes a multi-tenant system look correct while having no isolation at
all — and it is why ADR-0006 forbids the application from ever holding a superuser
credential.

## Local topology

| Purpose | Value |
| --- | --- |
| Server | PostgreSQL 18.6, native, `C:\pg18\pgsql` |
| Data directory | `C:\pg18\data` |
| Port | 5432 |
| Application database | `raptor_os` |
| Test database | `raptor_os_test` |
| Application role | `raptor_app` — `NOSUPERUSER NOBYPASSRLS` |
| Migration role | `raptor_migrator` — owns the schema, never present in an app environment |

Bootstrap is `packages/db/scripts/local-bootstrap.sql` and is idempotent.

## Consequences

**Positive**
- Real PostgreSQL: identical engine to production, so RLS, composite foreign keys,
  `numeric(18,4)`, partial indexes and transaction behaviour are all exercised for real
  rather than approximated.
- Standard tooling attaches natively — `psql`, DBeaver, any Postgres client.
- Faster, and no WebAssembly layer.

**Negative**
- The server must be running for integration tests, which CI must provision as a service.
- Windows-specific: startup is manual rather than a service. A start/stop helper is
  documented rather than assumed.

**Retained** — `pglite-socket` remains useful as an optional convenience for a
socket-backed in-memory database, but it is no longer load-bearing.

## Record-keeping

ADR-0002 is kept, not deleted. Its investigation was correct, its conclusion was correct
*given the evidence then available*, and the evidence changed. That sequence is worth
preserving: the decision record should show what was known when, not only what is true now.