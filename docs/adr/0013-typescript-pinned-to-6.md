# ADR-0013 — TypeScript pinned to 6.0.3, not the latest 7.0.2

**Status:** Accepted · **Date:** 2026-10-09

## Context

ADR-0009 requires the newest stable release of every dependency. As of this date that is
**TypeScript 7.0.2**, the native (Go) compiler. TypeScript 6.0.3 is the newest release of the
previous major.

TypeScript 7 fails the lint gate:

```
typescript-eslint does not support TS 7.0.

ESLint: 10.12.0
Error: typescript-eslint does not support TS 7.0.
```

`typescript-eslint` refuses to load, so **ESLint cannot run at all**. Its own error output
points to the workaround — run it against the TypeScript 6 API, which TypeScript 7 supports
side-by-side with — but doing that means the type-aware lint rules analyse a *different*
type system than the one that actually compiles the code, which quietly weakens the gate.

## Decision

Pin **TypeScript 6.0.3**.

## Rationale

ADR-0012 makes the lint and typecheck gates release blockers and explicitly forbids
weakening them. Two rules cannot both hold when the linter cannot parse the compiler's
language version, and the gate wins.

An unsupported major is not "latest stable" in any meaningful engineering sense — it is the
newest release of a toolchain whose analysis layer has not caught up. Adopting it would mean
either shipping with no linting (the exact failure the legacy project had: a shipped
`ReferenceError`, undefined RPCs, and a `ReferenceError` in an attendance handler that a
single `tsc` run would have caught) or running a linter against the wrong type system.

The side-by-side arrangement was considered and rejected: it gives two type systems in one
repository, and lint results would no longer describe the code that ships.

## Consequences

**Positive** — lint, typecheck and tests all run against one TypeScript version. The gate
is real, not decorative. TypeScript 6 already provides `strict`, `noUncheckedIndexedAccess`,
`verbatimModuleSyntax` and everything else this codebase relies on.

**Negative** — one major behind on the language. New TS7-only syntax and the native
compiler's speed advantage are unavailable. Build times are marginally slower.

**Exit criterion** — move to TypeScript 7 when `typescript-eslint` declares support. That is
tracked upstream at `typescript-eslint#10940` (support for TS >= 7.1). At that point this
ADR is superseded, not edited.

**Verified after the change**

| Gate | Result |
| --- | --- |
| `eslint packages --max-warnings 0` | exit 0 |
| `tsc --noEmit` (core, db, observability) | clean |
| `vitest run` | 68 + 10 + 29 = 107 tests passing |

## Related

The linter immediately found real defects on first run — an unused import, an unused
constant, and four unnecessary type assertions — none of which TypeScript's compiler
reported. That is the argument for keeping this gate, not weakening it.