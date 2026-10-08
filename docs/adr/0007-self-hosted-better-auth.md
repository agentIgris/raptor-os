# ADR-0007 — Better Auth, self-hosted

**Status:** Accepted · **Date:** 2026-10-09

## Context

Raptor OS is built against local PostgreSQL with no external identity provider. Auth must
still satisfy what the audit demanded and what an enterprise buyer's security review
requires: httpOnly cookie sessions, PKCE, TOTP MFA, and **provable** revocation.

The legacy app stored the session — including the refresh token — in `localStorage`, had no
MFA even for administrators, had no `/auth/reset-password` route despite linking to one,
and left a dormant `createAdminProfile` helper in a client-reachable library capable of
minting an admin row.

## Decision

Use **Better Auth**, self-hosted, with a database adapter. Session cookies are httpOnly,
`Secure`, `SameSite=Lax`. TOTP MFA is mandatory for privileged roles.

## Consequences

**Positive** — actively maintained; auditable source; database-agnostic so the local
Postgres and a future managed instance behave identically; MFA and revocation are solved
rather than bespoke.

**Negative** — a dependency with full access to the user table, so it is held to the same
dependency-scanning and supply-chain standard as everything else. Being third-party means
its session semantics are not ours to prove from first principles; mitigated by
integration tests covering session issuance, refresh, revocation and MFA enforcement.

**Rejected: hand-rolled auth.** Argon2id plus a custom session table is entirely feasible,
but MFA enrolment, recovery codes, brute-force throttling and replay handling are exactly
where bespoke auth goes subtly wrong. The audit's most damning finding was a shipped
`ReferenceError` caused by having nothing run; writing security primitives with no
external review repeats that error at a higher stakes.

**Rejected: an external IdP (Keycloak et al.)** — no container runtime available, and it
adds a heavyweight always-on service dependency.