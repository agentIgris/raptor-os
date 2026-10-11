# ADR-0020 — Supabase CLI adopted for schema tooling; the local stack needs Docker

**Status:** Accepted · **Date:** 2026-10-11
**Relates to:** [ADR-0008](0008-node-native-infrastructure-substitutes.md), [ADR-0015](0015-pglite-restored-after-native-postgres-retest.md), [ADR-0007](0007-better-auth-self-hosted.md)
**Supersedes:** the "no Docker" constraint in ADR-0008

## Decision

Install the Supabase CLI (`supabase` 2.120.0, exactly pinned in the root `devDependencies` per
ADR-0009), initialise a Supabase project at the repository root, and configure
`supabase/config.toml` deliberately rather than leaving the generated defaults.

**Authentication is not being replaced.** ADR-0007 stands: Better Auth remains the
application's auth. What Supabase is being adopted for is **schema tooling** — the PostgreSQL
linter, migration bookkeeping, type generation, and an option to run the reference stack
locally or against a managed project. Two auth systems in one product is the exact defect this
project has spent seven phases removing (two identity models in ADR-0018, two permission
systems, two attendance definitions), so the CLI is a build-time tool here, not a runtime
dependency.

## What was configured, and why each default was wrong

`supabase init` writes defensible defaults for a demo. Each of these was changed, with the
reason recorded in the file:

| Setting | Default | Changed to | Reason |
| --- | --- | --- | --- |
| `minimum_password_length` | 6 | 12 | `packages/auth` enforces 12. Two password policies that disagree is a class of defect this repo exists to remove |
| `password_requirements` | `""` | `lower_upper_letters_digits` | Length alone is a weak policy; the legacy system enforced length only |
| `enable_confirmations` | `false` | `true` | The security review found `requireEmailVerification` is only as strong as the signing secret behind it |
| `secure_password_change` | `false` | `true` | A password change is the incident-response action; allowing it from a hijacked session hands the attacker a permanent credential |
| `max_frequency` | `1s` | `60s` | Throttle on email enumeration and reset flooding. `1s` locally means `1s` in production if the file is copied |
| `refresh_token_reuse_interval` | `10` | `0` | A reuse window means a stolen refresh token replayed inside it is accepted — the window rotation exists to close |
| `max_enrolled_factors` | 10 | 1 | Three enrolled authenticators is three ways to lose access and three places a leaked QR sits |
| `[auth.mfa.totp]` | both `false` | both `true` | The legacy system had no second factor at all, including for admins (F-AUTH-03) |
| `additional_redirect_urls` | one https origin | both `localhost` and `127.0.0.1`, http and https | They are **different origins to a browser**. Listing one silently breaks sign-in for anyone who reached the app by the other name |

The MFA note is explicit in the file: enabling TOTP makes a second factor *available*, not
*required*. Supabase has no per-role MFA requirement, so whether a given session must present a
factor is this codebase's policy to enforce — which is what `packages/auth` and its
`user_mfa_guard` trigger already do for the Better Auth path.

## Blocker: the local stack cannot start without Docker

`supabase start` fails:

```
{"code":"DockerLifecycleInspectError",
 "message":"failed to inspect container health: docker: command not found
            (podman also not found) - install Docker Desktop or Podman and ensure it is on PATH"}
```

Neither is installed. `winget install Docker.DockerDesktop` was attempted and requires
elevation this session does not have; `Get-WindowsOptionalFeature` for Hyper-V likewise
returns `The requested operation requires elevation`.

**Update (2026-10-11):** Docker Desktop 4.94.0 installed successfully via winget (the
installer elevation was approved), but the engine never starts: the Desktop processes launch
and exit silently with no log output. Root cause is the missing WSL2 backend — `wsl --list`
reports WSL is not installed at all — and `wsl --install` plus enabling the
`VirtualMachinePlatform` feature both require elevation. An explicit UAC request
(`Start-Process -Verb RunAs`) was declined. So Docker is present but inert: no daemon, no
`docker` server, `supabase start` still fails at container health inspection.

Two ways forward, neither available from inside this session:

1. **Approve one UAC prompt for WSL2.** Run `wsl --install` from an elevated PowerShell
   (right-click → Run as administrator), reboot if asked, then relaunch Docker Desktop and
   run `supabase start`. This keeps everything local, which is what ADR-0008 originally
   wanted.
2. **Link a Supabase Cloud project instead.** `supabase link` needs no Docker and no
   elevation — it only needs a project ref and an access token from supabase.com (free tier
   suffices). Then `supabase db push` applies the generated baseline, and browser auth runs
   against the hosted Auth server. Trade-off: the database leaves the machine, so the
   "complete entire project locally" constraint is relaxed for the backend runtime while the
   schema, tests and tooling stay local.

**This supersedes the "no Docker" rule in ADR-0008.** That rule was a genuine constraint and is
being relaxed by decision, not by drift.

## What works today, without Docker

- `supabase --version` → `2.120.0`
- `supabase init` → `supabase/config.toml`, validated (an earlier parse error was fixed: a
  speculative `[auth.email.template]` section is not in the CLI's schema, and standard TOML
  accepting it is not evidence the CLI will)
- `supabase migration new` → migration scaffolding
- `supabase db lint` → the pgsupabase PostgreSQL linter, which is the most valuable Docker-free
  addition: it applies Supabase's own advisory rules to the schema

## Schema mirror, generated not copied

`supabase/migrations/` holds one generated baseline concatenating all 13 canonical migrations
from `packages/db/migrations/`, produced by `scripts/sync-supabase-baseline.ts`. It is marked
GENERATED — DO NOT EDIT at the top of the file.

A hand-copied mirror would be a second schema that can drift silently, which is the precise
failure mode this project has been eliminating. The canonical schema remains
`packages/db/migrations/`; the baseline is regenerated from it on demand.

The script resolves its repository root from `import.meta.url` rather than `process.cwd()`,
because `tsx` is only a dependency of `packages/db` and the script is therefore invoked from
two different working directories. A `cwd`-relative root works until someone runs it the other
way.

## What is NOT done

- `supabase start` — blocked on Docker.
- No cloud project is linked. Nothing was authenticated against `api.supabase.com`, no access
  token was created, and no credential was introduced into this repository.
- No Supabase client library was added to `apps/web` or any package.