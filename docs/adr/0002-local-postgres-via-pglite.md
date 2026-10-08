# ADR-0002 — Local PostgreSQL via PGlite, not a PostgreSQL server

**Status:** Accepted
**Date:** 2026-10-09

## Context

Raptor OS must be developed and fully tested against a real PostgreSQL locally,
before any cloud database exists. The target machine has no container runtime and
no PostgreSQL installation.

Attempts made, in order:

| Attempt | Outcome |
| --- | --- |
| `winget install PostgreSQL.PostgreSQL.18` | EDB download returned **HTTP 403 Forbidden** |
| `choco install postgresql18` | Broken dependency chain (`kb2919442` unresolvable); also no elevation |
| Direct download of `postgresql-18.6-5-windows-x64-binaries.zip` | Succeeded after resuming a truncated transfer — 384 MB, 22,098 entries |
| `initdb` on the extracted binaries | Succeeded; cluster created |
| `pg_ctl start` + `psql` connect | Server reached `ready to accept connections`, then **every forked child process died** |

The child-process failure is consistent and reproducible:

```
client backend (PID 2136) was terminated by exception 0xC0000142
could not reserve shared memory region (addr=0000024B02800000) for child ...: error code 487
```

`0xC0000142` is `STATUS_DLL_INIT_FAILED`; error 487 is `ERROR_INVALID_ADDRESS`.
Single-process invocations from the same binaries work correctly (`postgres --version`
reports 18.6, `initdb` completes). The failure is specific to PostgreSQL's
fork-plus-shared-memory process model, which the sandbox does not permit.

## Decision

Use **PGlite** — PostgreSQL compiled to WebAssembly, running in-process — as the local
development and test database.

## Verification performed

PGlite was proven to support the specific guarantees this project depends on before
being adopted. These are not assumptions; each was executed:

| Requirement | Result |
| --- | --- |
| Real PostgreSQL semantics | Reports `PostgreSQL 18.3 (PGlite 0.5.8) on wasm32` |
| `numeric(18,4)` exactness | `12345.6789::numeric(18,4)` → `12345.6789` |
| `gen_random_uuid()` (core, no extension) | Working |
| Row Level Security enforcement | Enforced under a `NOSUPERUSER NOBYPASSRLS` role |
| Composite FK blocking cross-tenant rows | Cross-tenant insert rejected; same-tenant accepted |

RLS enforcement test, verbatim result:

```
org-a sees: [ 'org-a-data' ]
org-b sees: [ 'org-b-data' ]
cross-tenant FK rejected: violates foreign key constraint "child_tenant_fk"
same-tenant FK accepted: OK
```

## Consequences

**Positive**
- Zero installation, no elevation, no container runtime, no cloud account.
- Test suites can run a real database in-process with no server lifecycle to manage.
- CI can run the identical integration tests with no service container.

**Negative — accepted knowingly**
- No TCP listener, so tools that expect a socket (`psql`, `pgAdmin`, some migration
  tooling) cannot attach directly. Mitigated by PGlite's socket-server extension
  where a socket is genuinely required.
- Single-writer. The application is designed as a single Node process talking to one
  database instance, so this does not constrain us.
- Performance is below native PostgreSQL. Irrelevant at development scale; production
  targets native PostgreSQL.
- PGlite ships a subset of contrib extensions. `pgcrypto` is not bundled
  (`gen_random_uuid()` is core since PostgreSQL 13, so nothing is lost).

**Migration path to production**
The application is written against standard PostgreSQL. Nothing in the schema, the
RLS policies, or the migration ledger is PGlite-specific. Switching the connection
to a managed PostgreSQL instance is a connection-string change, not a rewrite.

## Alternatives rejected

- **Embedded PostgreSQL npm packages** (`embedded-postgres`, 18.4.0-beta) — they
  launch the same native server binary and would hit the identical shared-memory
  failure. Also beta.
- **Fixing the native install** (Visual C++ redistributable, DLL search path) — the
  failure is in shared-memory reservation, not DLL resolution, and no amount of
  PATH manipulation addresses it.
- **Container runtime** — no Docker or Podman present; installing Docker Desktop
  requires WSL2 and a reboot.
- **In-memory fake database** — cannot test RLS, composite FKs, or any of the
  constraints the tenancy model depends on. Would defeat the purpose.