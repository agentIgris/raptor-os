# ADR-0015 — PGlite is the local database; supersedes ADR-0014, restores ADR-0002

**Status:** Accepted · **Date:** 2026-10-09
**Supersedes:** [ADR-0014](0014-native-postgres-supersedes-pglite.md)
**Restores:** [ADR-0002](0002-local-postgres-via-pglite.md)

## Why this ADR exists

ADR-0014 was wrong. It is superseded because it was decided on insufficient evidence,
and this document records that plainly rather than quietly replacing the earlier claim.

## What ADR-0014 concluded, and why it was wrong

ADR-0014 stated that removing McAfee had fixed native PostgreSQL. Its entire evidence was
**a single successful `psql` connection** taken moments after startup.

A single successful connection proves the postmaster started. It does not prove that
*backends* can be created. PostgreSQL on Windows is multi-process: the postmaster forks a
separate backend per connection. Those backends were the thing failing all along.

The claim was also internally inconsistent with evidence already on record. ADR-0002 had
recorded the child processes dying with `0xC0000142`; ADR-0014 attributed that to McAfee
without re-testing it under load.

## The retest

Thirty sequential short-lived connections, after a clean restart:

```
connections attempted : 30
succeeded             : 0
failed                : 30
success rate          : 0%
distinct failure modes:
  x30  psql: error: connection to server at "127.0.0.1", port 5432 failed:
           server closed the connection unexpectedly
```

Not intermittent. **Zero percent.** The server collapsed from nine processes to two during
the run.

The server log shows the cascade precisely:

```
LOG:  client backend (PID 13212) was terminated by exception 0xC0000142
LOG:  terminating any other active server processes
LOG:  all server processes terminated; reinitializing
LOG:  could not reserve shared memory region (addr=...) for child ...: error code 487
LOG:  could not reserve shared memory region (addr=...) for child ...: error code 487
```

The first backend dies, which makes the postmaster tear down every server process and
reinitialise. After reinitialisation **no** further child can be created, so every
subsequent connection is refused.

### Decoding the two error codes

- `0xC0000142` is `STATUS_DLL_INIT_FAILED`. A DLL failed its initialiser inside a freshly
  created process. This is the signature of software injecting into process creation.
- `487` is `ERROR_INVALID_ADDRESS`, returned when the backend cannot map the shared segment
  at the address the postmaster reserved.

### Attempts to fix it without administrator rights

Both were tried and both failed, which is why this is an environment limit rather than a
missing step:

1. **`shared_memory_type = sysv` / `dynamic_shared_memory_type = sysv`.** Intended to route
   shared memory around the `CreateFileMapping` path entirely. PostgreSQL rejected it at
   startup:

   ```
   LOG:  invalid value for parameter "shared_memory_type": "sysv"
   HINT: Available values: windows.
   FATAL: configuration file contains errors
   ```

   This build accepts `windows` only, so `CreateFileMapping` is unavoidable.

2. **Removing the suspected injector.** `McAfee WebAdvisor` survives as an orphaned service
   after the McAfee uninstall, and is a plausible process-creation injector. Stopping or
   disabling it requires elevation:

   ```
   [SC] OpenService FAILED 5:  Access is denied.
   ```

   The shell session is not administrative, and enabling AV exclusions or removing a
   Windows service would both require the same elevation.

**Conclusion:** native PostgreSQL cannot run reliably on this machine, and the cause cannot
be removed without administrator access that is not available here. ADR-0002's original
conclusion was correct all along.

## Decision

Use **PGlite** as the local development and test database, in-process. Native PostgreSQL
remains the production target; the switch is a connection-handling change confined to the
data layer, not a rewrite (ADR-0014's positive reasoning about that still holds).

## Why PGlite is acceptable for verifying the tenancy guarantees

The objection to PGlite is that it may be unable to express what ADR-0006 depends on, which
would make the isolation suite decorative. That was tested rather than assumed, in
`packages/db/scripts/pglite-capability.ts`:

```
PASS  server version                         PostgreSQL 18.3 (PGlite 0.5.8)
PASS  CREATE ROLE ... NOSUPERUSER NOBYPASSRLS  rolsuper=false rolbypassrls=false
PASS  create + seed tenant table as owner      two tenants seeded
PASS  SECURITY DEFINER function                returned invoked
PASS  composite foreign key                    created and seeded
PASS  SET ROLE probe_app                       current_user = probe_app
PASS  RLS filters to the caller tenant         saw [1] - org B correctly hidden
PASS  a different tenant sees the other row    saw [2]
PASS  unset tenant context fails CLOSED        saw [] - zero rows
PASS  superuser comparison sees everything     saw [1, 2]
PASS  cross-tenant composite FK is REJECTED    rejected by the database, as required
```

Every property the tenancy design relies on is present and enforced:

- a `NOSUPERUSER NOBYPASSRLS` role that can be assumed;
- `SECURITY DEFINER` functions with a pinned `search_path`, which is how
  `auth_session_by_token` resolves identity without a tenant-parameter bypass;
- forced RLS that genuinely filters, and **fails closed** when the tenant context is unset;
- composite foreign keys that reject cross-tenant references in the database itself;
- and, as a control, a superuser connection that sees everything — reproducing exactly the
  leak ADR-0006 exists to prevent.

The tenth line is the important one. It is the same demonstration ADR-0006 recorded, now
reproduced on the database actually used, which is what makes the other nine lines
meaningful.

### What is given up

PGlite is a single in-process session, so tests cannot hold two concurrent connections the
way a server allows. Assertions that previously used a second connection instead assume the
non-superuser role with `SET ROLE` and reset it afterwards. This still exercises real
PostgreSQL semantics — triggers, `timestamptz` comparison, `RAISE EXCEPTION`, forced RLS —
because those live in the engine, not in the transport. The wire protocol is not part of what
is being verified, so no fidelity is lost in the property under test.

The cost is real and recorded: concurrent-connection behaviour is no longer covered locally.
That gap belongs in CI against a real PostgreSQL service, not in a local substitute.

## Local topology

| Purpose | Value |
| --- | --- |
| Engine | PGlite 0.5.8 — PostgreSQL 18.3 compiled to WebAssembly |
| Mode | In-process, one instance per test process |
| Owner role | superuser, used only to create schema |
| Assertion role | `NOSUPERUSER NOBYPASSRLS`, assumed with `SET ROLE` |
| Production | Standard PostgreSQL |

## Consequences

**Positive**
- Deterministic. No AV interference, no service management, no shared-memory failure mode.
- Tests are hermetic and parallel-safe, because each process owns its own database.
- Real PostgreSQL 18 semantics for every property the design depends on.

**Negative**
- A server-free substitute is not a production rehearsal; load and concurrency behaviour is
  unverified locally.
- Windows-native tooling (`psql`, DBeaver) cannot attach, which costs some convenience.
- The 18.3 engine lags the 18.6 native binaries, so a very recent server feature could be
  unavailable locally.

**The lesson, recorded deliberately:** one successful connection was treated as proof of a
property that only repeated trials could establish. Any future environment claim in this
repository should name the trial that supports it.