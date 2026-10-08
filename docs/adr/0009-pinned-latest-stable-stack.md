# ADR-0009 — Latest stable, exactly pinned, audit-clean

**Status:** Accepted · **Date:** 2026-10-09

## Context

The legacy stack carried **97 known advisories** (4 critical, 40 high) and, decisively, its
Next.js version was **permanently unpatchable**. Two unauthenticated RCE advisories affect
`>=13.4.0 <15.5.24` and `>=10.0.0 <15.5.24`; the fix is 15.5.24+, so no version of the 14.x
line is ever clean. Five advisories on that line required 14.2.31–14.2.35, yet even 14.2.35
remains exposed to the two criticals.

`jspdf` carried 11 advisories including two criticals. `dompurify` carried 20 transitively.

## Decision

Adopt the newest stable release of each dependency, **pin exactly** (no `^`, no `~`, no
`latest`), and verify the assembled tree audits clean before the first commit.

## Verification

A candidate stack was installed and audited for real, not assumed:

| | Legacy | Candidate |
| --- | --- | --- |
| critical | 4 | **0** |
| high | 40 | **0** (prod) |
| moderate | 45 | **0** |
| low | 8 | **0** |
| **total** | **97** | **0** prod / 1 dev (transitive `braces`) |

## Selected stack

`next 16.4.0` (verified clean of all 28 known `next` advisories) · `react 19.3.0` ·
`typescript 7.x` · `tailwindcss 4.3.x` (v4 CSS-first) · `eslint 10` with a **matched**
`eslint-config-next 16` pair · `@supabase/*` removed entirely · `pg` + `drizzle-orm` ·
`better-auth` · `zod 4` · `vitest 5` + `@playwright/test` · `recharts 3.10.x` ·
`jsPDF 4.2.x` (criticals fixed) · `react-markdown` + `rehype-sanitize` · `pnpm 12` · Node 22 LTS.

Deliberately dropped from the legacy tree: `animejs`, `embla-carousel`, `vaul`, `cmdk`,
`sonner`, `react-error-boundary`, `resizable-panels`, `input-otp` (all dead), and
`html2canvas` (client-side PDF rasterisation → server-side rendering).

## Consequences

**Positive** — zero known vulnerabilities at the starting point; no unreviewed framework
advisories; the ESLint/config-next version mismatch that made lint decorative in the legacy
repo is gone.

**Negative** — exact pinning means upgrades are deliberate and manual. Mitigated by
Dependabot/Renovate plus `pnpm audit` as a release gate; a caret range is how the legacy
repo ended up exposed in the first place.

**On Tailwind v4** — it is a CSS-first configuration model, i.e. a genuine rewrite of the
theme layer, not a version bump. Accepted deliberately so the design-system foundation is
built once, correctly.

**Rule:** a dependency is never merged unless `pnpm audit --prod` reports zero
critical/high and the version is pinned exactly.