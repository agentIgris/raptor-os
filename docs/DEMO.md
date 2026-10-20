# Demo runbook

How to get the whole stack running and what to show with it.

---

## 1. What the demo is

One process on port 3000 serving four surfaces, one Postgres database with
91 domain tables behind forced row-level security, one identity, and one CMS
that shares that identity.

| Surface | URL | What it demonstrates |
| --- | --- | --- |
| Public fan site | `/` | a published roster, competitions, partners, content — all read through published views, no login |
| Workspace | `/dashboard` | the role-aware operating console: teams, members, competitions, insights, content, partners, settings, assistant |
| Assistant | `/assistant` | a role-scoped, offline read tool over the tenant's own data |
| CMS admin | `/cms-admin` | the Payload content plane, authenticating with the SAME identity as the product |

---

## 2. From a clean clone to a running stack

```sh
git clone https://github.com/agentIgris/raptor-os.git
cd raptor-os
pnpm install
pnpm bootstrap
pnpm dev:local
```

`pnpm bootstrap` does the database, the roles, the schema, the migrations, the
`.env.local` and the seed accounts. It is idempotent — run it as often as you
like.

Then open <http://localhost:3000>.

### The fast path: the committed snapshot

The repository carries a snapshot of a populated local database, so a fresh
clone can reach a filled-in environment without re-seeding:

```sh
pnpm install
node scripts/setup-local.mjs      # databases, roles, schema, preview data
node scripts/restore-local-db.mjs # replay the snapshot
pnpm dev:local
```

`restore-local-db.mjs` also hands the committed credential fixture to
`.data/seed-role-accounts.json`, so the role accounts and the tools that read
that file agree.

> The snapshot holds LOCAL-DEV-ONLY data — fixed local passwords and a
> development database. It is not a production export, and the restore script
> must never be pointed at a real environment.

---

## 3. The accounts

All seven use the local-only password `raptor_local_dev_only`.

| Account | Role | The demo moment |
| --- | --- | --- |
| `owner@raptor.local` | owner | everything, including the CMS admin console |
| `admin@raptor.local` | admin | the org overview, the member list |
| `manager@raptor.local` | manager | member data, insights, roster |
| `analyst@raptor.local` | analyst | insights, roster |
| `coach@raptor.local` | coach | insights, roster |
| `player@raptor.local` | player | teams and competitions only |
| `pending@raptor.local` | pending | refused everywhere — the default a sign-up lands on |

The last one is worth showing: sign in as `pending@raptor.local` and the
workspace refuses you. That is the same role the database would have refused
to promote without the enrolment flag.

---

## 4. The tour (about five minutes)

1. **The public site** (`/`) — the fan-facing surface. Teams, competitions,
   partners and news, all read from published content through the
   public-read views.
2. **Sign in** (`/sign-in`) — one field, one password. This build does not
   ask for a 6-digit code; see §6.
3. **The workspace** (`/dashboard`) — sign in as `coach@raptor.local`. The
   navigation is scoped to the role: no members, no org overview.
4. **The assistant** (`/assistant`) — ask *"Give me the roster and the
   insights."* A player gets the teams; a coach gets the roster and the
   insights; a manager additionally gets the member list. The tool set is
   decided by one object, `packages/assistant/src/matrix.ts`, and the answer
   is generated on the machine, offline.
5. **Sign in as `manager@raptor.local`** — the member list appears. Same
   server, same data, different scope.
6. **The CMS** (`/cms-admin`) — sign in as `owner@raptor.local`. There is no
   second admin password: the session cookie is the same one the product
   issues, resolved through `cms_operator_session()`.
7. **The proof** — in a second terminal:

   ```sh
   node scripts/verify-assistant-roles.mjs
   ```

   It signs in as each of the seven accounts, asks the assistant a question,
   and checks the tool set against the matrix in the source. Every role must
   get exactly the tools it is granted, `pending` must be refused, and no
   session may point at another organisation.

---

## 5. What to say about the security model

The demo is small, but the controls are real, and they are the point:

- the role is never client-supplied — a request body carrying `role` is
  refused;
- a privileged account may not exist without the enrolment flag, and that
  rule is a database trigger, not an application check;
- every tenant table has forced RLS, so a bug in application code stays inside
  one tenant;
- the session is an `httpOnly` cookie that never touches `localStorage`, and
  it really rotates;
- a wrong password is bounded per ACCOUNT (5 failures, 15 minutes), not only
  per IP;
- every mutation is audited.

The details, and the evidence for each, are in [SECURITY.md](./SECURITY.md).

---

## 6. The one deviation, stated plainly

**This build does not ask for a 6-digit code.** The `twoFactor` plugin is not
installed, so `/two-factor/enable` and `/two-factor/verify-totp` answer
404, and a password is the whole sign-in for every role — owner and CMS admin
included.

What has *not* been switched off: the role policy, the database trigger, the
two session gates, the account lockout, the per-IP limiter, CSRF and origin
checks, the RLS policies, the audit log, and the role scoping.

So: **a privileged account in this build is protected by its password alone.**
That is acceptable for a demo on a local machine and is not acceptable for a
deployment holding real data. The three steps to put the second factor back
are in [SECURITY.md → Re-enabling the challenge](./SECURITY.md#re-enabling-the-challenge).

---

## 7. Rehearsing the demo

```sh
node scripts/create-role-accounts.mjs   # rebuild the seven accounts
node scripts/verify-assistant-roles.mjs  # re-run the proof
```

Both are idempotent enough to run before every demo. The seed deletes and
rebuilds the accounts' authentication rows, so the sessions from a previous
run stop working — which is exactly what you want between rehearsals.

The sign-in rate limit is 5 attempts per 60 seconds per IP, and the scripts
pace themselves around it. If you sign in by hand repeatedly, you will see a
429: wait a minute.

---

## 8. Troubleshooting

| Symptom | Fix |
| --- | --- |
| `/api/auth/*` answers 503 | start with `pnpm dev:local`, not `pnpm dev` — the root `.env.local` is only loaded by the former |
| "Database schema mismatch" | `node scripts/setup-local.mjs` |
| `ECONNREFUSED 127.0.0.1:5432` | start the Postgres service |
| The CMS admin refuses the owner | the owner must be in `cms_operators`; `SELECT * FROM cms_operators;` shows who is |
| "role may not be held without an enrolled TOTP authenticator" | the flag is missing: `UPDATE auth_user SET "twoFactorEnabled" = true WHERE email = '...'` |
| 429 on sign-in | the per-IP budget; wait a minute |

The full table is in [SETUP.md → Troubleshooting](./SETUP.md#troubleshooting).
