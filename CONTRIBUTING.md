# Contributing

Thanks for working on Raptor OS. This file is the short version; the long
version lives in [`docs/DEVELOPMENT.md`](./docs/DEVELOPMENT.md).

---

## The shape of a contribution

1. **Understand the area.** Read the file's header comment before the code.
   In this repository the header is where the reasoning, the measurements and
   the traps live.
2. **Write the failing test first**, and watch it fail. A test that passes
   whether or not the control exists is decoration.
3. **Change the smallest thing that makes the test pass.**
4. **Update the comments that describe what you changed.** A comment that
   describes a control that no longer exists is a defect.
5. **Run the gate.** `pnpm verify` — lint, typecheck, every suite. It must be
   green.
6. **Prove it live** if it touches the running stack:
   `node scripts/verify-assistant-roles.mjs`.
7. **Commit** with a conventional subject and a body that explains why.

---

## The gate

```sh
pnpm verify
```

That is exactly what CI runs. Nothing is merged on a red gate, and a gate
that has been "temporarily" relaxed is a gate that is gone — CI asserts that
`ignoreBuildErrors` and `ignoreDuringBuilds` never appear in a config, and
that no bare `console.*` reaches application code.

If a test fails and you believe the test is wrong, say so in the pull request
with the reason. Do not weaken an assertion to make a suite green.

---

## Conventions

**Commits.** Conventional commits — `feat(scope):`, `fix(scope):`,
`docs(scope):`, `refactor(scope):`, `test(scope):`, `chore(scope):`. The
subject is a command and fits on one line. The body explains **why**, and
where a claim is being made, **how it was verified**.

**Branches.** `feat/…`, `fix/…`, `docs/…`, `chore/…`.

**TypeScript.** Strict, no `any`, `import type` for type-only imports. When a
library type does not fit, narrow to `unknown` and read the value
structurally. Do not cast to silence a type error.

**Comments.** Describe what the code does, and why where the why is not
obvious. Quote a measurement rather than assert a virtue.

**Logging.** `logger.*` from `@raptor/observability`. Never `console.*` in
application code. Never log a token, a password, a cookie, a connection
string or a request body.

**Styling.** `@raptor/ui` primitives and the design tokens. Both themes must
work.

**Migrations.** Forward-only. Add a new numbered file; never edit a landed
one. The identity schema (`packages/auth/src/schema.sql`) is not a migration
— it is a deployment-time asset owned by the auth package.

**Decisions.** A change that is a trade-off rather than an implementation
gets an ADR in `docs/adr/`, written when the decision is made. The format is
in [`docs/adr/README.md`](./docs/adr/README.md).

---

## Documentation is part of the change

If you change behaviour, update the document that describes it in the same
change, and say which document you updated in the pull request. The
documentation most likely to go stale is the documentation that names a
specific mechanism — the MFA flow, the rate limiter's arithmetic, the session
rotation, the RLS policies.

---

## Reporting a security issue

**Not** a public issue. Follow the disclosure process in
[`SECURITY.md`](./SECURITY.md).

---

## Pull requests

The template asks for four things: what changed, why, how it was verified
(paste the evidence), and what a reviewer must check. A reviewer should be
able to reproduce your verification from the description alone.
