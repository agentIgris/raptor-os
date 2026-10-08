# 03 — TECHNOLOGY STACK

**Audit.md section:** 6 (SECTION 03 — TECHNOLOGY STACK)

---

## 1. Declared stack (from `package.json`)

| Layer | Technology | Declared version | Resolved intent |
| --- | --- | --- | --- |
| Framework | Next.js (App Router) | `^14.2.30` | 14.x with React 18 |
| UI runtime | React / React DOM | `^18` | 18.x |
| Language | TypeScript | `^5.8.3` (dev) | `strict: true` |
| Database | Supabase (PostgreSQL) + PostgREST + RLS | `@supabase/supabase-js ^2.50.5` | hosted BaaS |
| Auth | Supabase Auth (email/password, PKCE) | via `@supabase/supabase-js` | no custom IdP |
| Service-role client | `@supabase/supabase-js` | same | used by 4 routes |
| Styling | Tailwind CSS | `^3.4.17` | v3 (not v4) |
| Component primitives | Radix UI | 24 pinned packages, mixed `1.x`/`2.x` | shadcn/ui |
| Component variants | `class-variance-authority ^0.7.1`, `clsx ^2.1.1`, `tailwind-merge ^2.5.5` | | |
| Charts | Recharts | `2.15.0` (pinned) + `@types/recharts ^2.0.1` | used in 1 file |
| PDF | jsPDF `^3.0.1` + `jspdf-autotable ^5.0.2` + `html2canvas ^1.4.1` | | client-side export |
| OCR | Tesseract.js | `latest` (**unpinned**) | client-side |
| Animation | framer-motion `^11.18.2`, animejs `^3.2.2` | | 1 file each |
| Carousel / drawer / a11y widgets | embla-carousel-react, vaul, cmdk, react-day-picker 8.10.1, input-otp | | all effectively unused |
| Markdown | react-markdown `^10.1.0` | | 2 files |
| Toasts | `sonner ^1.7.1` (unused) + shadcn `toast` | | |
| Theming | next-themes `^0.4.4` | | forced dark |
| Build | Next 14 + SWC minify + custom webpack `splitChunks` | | |
| Package manager | `pnpm@10.14.0` declared, **plus a committed `package-lock.json`** | | conflicting |
| Testing | **none** | | no runner, no config, no script |
| Lint | ESLint `^8.57.1` + `eslint-config-next 15.4.3` | | **version mismatch: ESLint 8 config with eslint-config-next 15**; lint disabled at build |
| Type-check | `tsc` | | **disabled at build** |
| Hosting | Vercel (implied by `vercel` branch, `.gitignore` `.vercel`, `NEXT_PUBLIC_VERCEL_URL`, `serverActions.allowedOrigins: ["*.vercel"]`) | | no IaC |
| CI/CD | **none in repository** | | |
| Email | **none** (`SMTP_*` documented, unused) | | |
| Error tracking | **none** (`SENTRY_DSN` documented, unused, no SDK) | | |
| Product analytics | **none** (`ANALYTICS_API_KEY` documented, unused) | | |
| Observability | **only `console.*`**, stripped in production | | |
| Validation | `zod ^3.24.1` declared, **never imported** | | |
| Forms | `react-hook-form ^7.54.1` used **only** by the unused `components/ui/form.tsx` | | all forms are hand-rolled `useState` |
| i18n | **none** | | English hardcoded |
| ORM / query builder | none — hand-written `Database` type + Supabase query builder | | |
| Migrations | **none** — 43 ad-hoc SQL files | | |

---

## 2. Verified runtime facts (what is actually used)

| Question | Answer | Evidence |
| --- | --- | --- |
| Is Next.js App Router used? | Yes, 100 % (no `pages/`) | directory listing |
| Is the Database Connector (Prisma/Drizzle) used? | **No.** A hand-maintained `Database` TypeScript type is used instead | `lib/supabase.ts:56-681` |
| Does the hand-written type cover the real schema? | **No.** It declares 14 tables; the SQL defines 32. It is missing `tryouts`, `tryout_applications`, `tryout_invitations`, `tryout_sessions`, `tryout_evaluations`, `tryout_selections`, `discord_servers`, `discord_users`, `performance_records`, `bot_attendance`, `holidays`, `practice_session_config`, `team_monthly_stats`, `user_agreements`, `attendance_debug_log` | `lib/supabase.ts:58-677` vs SQL inventory |
| Is `zod` used? | **No** — 0 imports | `rg "zod"` → only `package.json` |
| Is `react-hook-form` used? | Only inside `components/ui/form.tsx`, which nothing imports | `rg "useForm"` |
| Is Recharts used? | Yes — `components/analytics/advanced-charts.tsx` only | `rg -l recharts` |
| Is the Tesseract OCR server-side? | **No — 100 % browser-side.** `createWorker()` runs in the client | `lib/ocr-service.ts:16-19` |
| Is there a server-side OCR API? | **No** | no `app/api/ocr*` |
| Is email sent? | **No** | `rg "nodemailer|resend|sendgrid|postmark|SMTP"` → 0 |
| Is there error tracking? | **No** | `rg "Sentry|sentry"` → 0 |
| Are server logs emitted in production? | **No** — `compiler.removeConsole: NODE_ENV === 'production'` strips every `console.*` | `next.config.mjs:8-10` |
| Is middleware enforcing auth? | **No.** It sets 6 security headers and a dead CORS block | `middleware.ts` |
| Does middleware even run on `/api/*`? | **No** — the matcher negative-lookahead excludes `api/` | `middleware.ts:36` |
| Is the Content-Security-Policy set? | **No** | `middleware.ts` sets X-Frame-Options, X-Content-Type-Options, Referrer-Policy, X-XSS-Protection, HSTS, Permissions-Policy only |
| Is `X-XSS-Protection` useful? | No — deprecated and removed from modern browsers; it is *not* a substitute for CSP | `middleware.ts:11` |
| Is `next/image` optimisation used? | Disabled: `images.unoptimized: true` | `next.config.mjs:3-4` |
| Is there a database connection pooler / direct Postgres access? | No — PostgREST only; `DATABASE_URL` documented but unused | `.env.example:14` |
| Is `pg_cron` required? | Yes, for 6 scheduled jobs | `automation-scripts/README.md` |
| Are there Server Actions? | Configured but **none used** — all mutations go through route handlers | `next.config.mjs:25-27`; `rg "use server"` → 0 |

---

## 3. Version risk assessment

| Component | Declared | Risk | Note |
| --- | --- | --- | --- |
| `next` | `^14.2.30` | **HIGH** | Caret range on a framework with a known active RSC advisory; a dedicated unmerged branch `vercel/react-server-components-cve-vu-nkppb8` exists. Next 14 is also out of mainstream support for a new commercial SaaS. |
| `eslint-config-next` | `15.4.3` | **MEDIUM** | Mismatched with `eslint ^8.57.1` (v15 config expects ESLint 9 flat config). Lint is disabled at build anyway, so this is decorative. |
| `date-fns` | `latest` | **MEDIUM** | Unpinned; used in 7 files → non-reproducible behaviour over time. |
| `tesseract.js` | `latest` | **MEDIUM** | Unpinned; also downloads WASM + language data at runtime from a CDN by default (no SRI, no self-hosting). |
| `react-markdown` | `^10.1.0` | LOW | |
| `jspdf` | `^3.0.1` | LOW | major v3 is recent; `jspdf-autotable ^5.0.2` must be v3-compatible. |
| `@types/recharts ^2.0.1` + `recharts 2.15.0` | pinned | LOW | stub types package; low maintenance. |
| `autoprefixer ^10.4.20` in `dependencies` | | LOW | should be a devDependency; `postcss ^8.5` is correctly a devDependency. |
| Radix UI | 24 packages pinned to exact patch versions | LOW | pinning is good for reproducibility, but mixing `1.x` (radix-ui 1.2/1.1) and `2.x` (react-*-group 2.x) majors across the tree increases upgrade cost. |
| `@supabase/supabase-js ^2.50.5` | caret | LOW | |
| Node engine | not declared | MEDIUM | `README.md:81` says Node 18+; Next 14 supports 18/20. No `.nvmrc`, no `engines` field, no `volta` pin. |
| `packageManager` | `pnpm@10.14.0` | MEDIUM | `build.out` shows a build was attempted via a bare `pnpm` invocation that stalled on Corepack's interactive download prompt — i.e. the declared toolchain is not self-bootstrapping. |

---

## 4. Architectural pattern assessment

| Pattern | Present? | Evidence / note |
| --- | --- | --- |
| Layered architecture (routes → services → repositories) | **No** | logic duplicated in routes, `lib/`, and SQL functions |
| Repository pattern | No | direct Supabase query builder calls everywhere |
| Service layer | **No** | `modules/discord-portal` is the only quasi-service and it is unsound |
| DTO / mapper layer | No | raw DB rows returned to the browser, including `select('*')` |
| Dependency injection | No | module-level singletons (`authFlowV2`, `supabase`, `GlobalLoadingManager`) |
| Singleton / global state | **Yes, heavily** | `AuthFlowV2Manager`, `GlobalLoadingManager`, module-level `supabase` clients, `cacheManager` |
| Event bus / pub-sub | No | Discord notifications are called imperatively from routes |
| CQRS | No | |
| Soft delete | No | hard `DELETE` everywhere; no `deleted_at` column in any table |
| Optimistic updates | No | |
| Server-side rendering of data | **No** | every dashboard page is `'use client'` and fetches in `useEffect` |
| Streaming / suspense | No | a custom `GlobalLoading` overlay is used instead |
| Feature flags | No | one env flag: `NEXT_PUBLIC_DISABLE_AGREEMENT_ENFORCEMENT` |
| Multi-tenancy | **No** | no tenant/org entity, no `organization_id` in any table or type |
| Audit log | **No** | only `communication_logs` (Discord delivery), and it is publicly insertable |
| i18n | No | |
| Design tokens | **Partially** | shadcn CSS variables in `tailwind.config.ts` + `app/globals.css`, but a parallel hardcoded class system exists in `lib/global-theme.ts` |
| Dark mode | Forced | `defaultTheme="dark" enableSystem={false}` (`app/layout.tsx:55`) |
| Error boundary strategy | Partial | `LoadingErrorBoundary` + `error-boundary.tsx` + `error.tsx` + `global-error.tsx` — four layers |
| Rate limiting | **No** | see `lib/discord-bot-auth.ts` dead code |
| API versioning | **No** | flat `/api/*`; no version segment, no OpenAPI, no codegen |
| Input validation | Manual per-field | no schema library in use |

---

## 5. Stack verdict for V2

**KEEP (proven, low-risk):** Next.js App Router + TypeScript `strict`, Tailwind + shadcn/ui
(Radix) primitives, Supabase (Postgres + Auth + Storage) as the managed backend, Recharts,
jsPDF + autoTable, `date-fns` (pinned).

**REPLACE:**
- Next.js 14 → a currently supported major (pin exact version; add advisory scanning).
- `zod` — keep the dependency but **actually use it** as the single validation contract shared
  by API, forms and database-generated types.
- Hand-written `Database` type → **generated** types from the migration ledger
  (`supabase gen types`), so type/schema drift becomes a build error.
- Loose SQL scripts → versioned migrations in CI.
- `console.*` logging → structured logger + error tracking; remove
  `compiler.removeConsole` from production.
- Two lockfiles → one, with `pnpm` enforced via `packageManager` + CI `--frozen-lockfile`.

**REMOVE:** `animejs`, `@types/animejs`, `embla-carousel-react`, `vaul`, `cmdk`,
`react-resizable-panels`, `input-otp`, `sonner`, `@hookform/resolvers`,
`react-error-boundary`, `autoprefixer` (→ devDependency), the 29 dead `components/ui/*`
files, and both lockfile/`build.out`/`cache/config.json` artefacts.

**REPLACE (integrations):** client-side Tesseract OCR → a server-side OCR service with
confidence thresholds and human-in-the-loop confirmation (see `21_OCR.md`).

**ADD (absent capabilities):** a real service layer, a permission engine, an audit log, an
event bus, rate limiting, CSP, error tracking, product analytics, i18n, and a test suite.
