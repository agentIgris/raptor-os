# ADR-0008 — Node-native infrastructure substitutes; no Docker, no cloud

**Status:** Accepted · **Date:** 2026-10-09

## Context

The design requires private object storage with signed URLs, transactional email, and a
durable job queue. The machine has **no container runtime** — no Docker, no Podman, no
`nerdctl` — and no cloud credentials.

## Decision

Run each concern as a Node-native component with a clean seam to its managed equivalent.

| Concern | Local implementation | Production seam |
| --- | --- | --- |
| Object storage | Local disk behind a signed-URL asset service; authorisation checked **before** a URL is ever signed | S3-compatible object storage behind the same interface |
| Transactional email | Nodemailer → local SMTP sink | Any provider, same adapter |
| Durable queue | Postgres-backed queue (`pg-boss`) | Same queue, or a managed broker |
| Database | PGlite (ADR-0002) | Managed PostgreSQL, connection-string change only |

Interfaces are defined once and both implementations satisfy them. Nothing above the
adapter boundary knows which is in use.

## Consequences

**Positive** — nothing extra to install; runs today; each local implementation is a real
implementation, not a stub, so integration tests exercise production code paths.

**Negative** — the local SMTP sink does not send real mail, so bounce and complaint
handling can only be unit-tested here. Acceptable: the handler logic is provider-agnostic
and testable with recorded fixtures.

**Rejected: install Docker Desktop** — requires WSL2 and a reboot, for three processes that
are each a few hundred lines of Node.

**Rejected: use real cloud services during development** — contradicts the explicit
requirement that nothing external remain except credentials, and would put production data
in a third-party system during development.