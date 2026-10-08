# 04 — DEPENDENCY AUDIT

**Audit.md section:** 7 (SECTION 04 — DEPENDENCY AUDIT)
**Declared:** 60 runtime + 8 dev dependencies. **Actually imported:** see the "Used in" column.

Legend: `files=N` = number of non-`components/ui` source files importing the package.
`ui-only` = imported only by a `components/ui/*.tsx` wrapper that nothing itself imports.

---

## 1. Runtime dependency audit

| # | Dependency | Declared | Used in | Purpose | Security status | Still necessary? | V2 recommendation |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | `next` | `^14.2.30` | app-wide | Framework | **Caret range on a framework with an active RSC advisory; dedicated unmerged mitigation branch exists** | Yes | **REPLACE** — pin an exact, supported major; add OSV/Dependabot scanning |
| 2 | `react` / `react-dom` | `^18` | app-wide | UI runtime | Caret; React 18 EOL approaching for new products | Yes | **REPLACE** with the version required by the chosen Next major |
| 3 | `@supabase/supabase-js` | `^2.50.5` | 67 files | DB/Auth/Storage client | Current; `persistSession` in `localStorage` (see §3) | Yes | **KEEP**, but add SSR cookie-based session handling and a server-only client factory |
| 4 | `zod` | `^3.24.1` | **0 files** | Validation | Not used, so no risk — but also no benefit | **No** | **KEEP and ACTUALLY USE** as the single validation contract |
| 5 | `@hookform/resolvers` | `^3.9.1` | **0 files** | Form schema resolvers | — | **No** | **REMOVE** (or use together with zod + RHF once forms are rebuilt) |
| 6 | `react-hook-form` | `^7.54.1` | 1 file (`components/ui/form.tsx`, itself unused) | Form state | — | Effectively **No** | **KEEP** for V2 forms; rebuild all forms on it |
| 7 | `class-variance-authority` | `^0.7.1` | 10 files | Variant API | — | Yes | **KEEP** |
| 8 | `clsx` | `^2.1.1` | via `lib/utils.ts` | Class merge | — | Yes | **KEEP** |
| 9 | `tailwind-merge` | `^2.5.5` | via `lib/utils.ts` | Tailwind conflict resolution | — | Yes | **KEEP** |
| 10 | `tailwindcss-animate` | `^1.0.7` | `tailwind.config.ts` | Animations | — | Yes | **KEEP** |
| 11 | `lucide-react` | `^0.454.0` | **95 files** | Icons | — | Yes | **KEEP** |
| 12 | `tailwindcss` | `^3.4.17` (dev) | build | CSS | v3 is in maintenance; v4 changes the config model | Yes | **KEEP v3** for stability, or migrate deliberately to v4 |
| 13 | `recharts` | `2.15.0` | **1 file** (`advanced-charts.tsx`) | Charts | — | Yes (if charts stay) | **KEEP**, pinned; drop `@types/recharts` stub |
| 14 | `jspdf` | `^3.0.1` | 1 file (`lib/pdf-export.ts`) | PDF | — | Yes | **KEEP** for client-side exports |
| 15 | `jspdf-autotable` | `^5.0.2` | 1 file | PDF tables | — | Yes | **KEEP** (verify v3 compatibility) |
| 16 | `html2canvas` | `^1.4.1` | 1 file | DOM → canvas | Known to be slow/heavy; DOM-clone based | Marginal | **REPLACE** with a server-side PDF renderer for V2 reports |
| 17 | `tesseract.js` | **`latest`** | 1 file (`lib/ocr-service.ts`) | OCR | **Unpinned**; downloads WASM + `traineddata` from CDN at runtime; CPU-heavy in-browser | Questionable | **REPLACE** with a server-side OCR service (see `21_OCR.md`) |
| 18 | `date-fns` | **`latest`** | 7 files | Dates | **Unpinned** | Yes | **KEEP but pin** to an exact version |
| 19 | `framer-motion` | `^11.18.2` | 1 file (`count-up.tsx`) + `faq/page.tsx` | Animation | — | Marginal | **REMOVE** — CSS transitions cover the actual usage |
| 20 | `animejs` + `@types/animejs` | `^3.2.2` | 1 file | Animation | `animejs` v3 is legacy (v4 is a rewrite) | **No** | **REMOVE** |
| 21 | `react-markdown` | `^10.1.0` | 2 files | Markdown | Renders untrusted-ish content; needs a sanitiser if fed user data | Yes | **KEEP** + add `rehype-sanitize` if user content is ever rendered |
| 22 | `next-themes` | `^0.4.4` | 2 files | Theming | — | Yes | **KEEP** |
| 23 | `react-day-picker` | `8.10.1` | `components/ui/calendar.tsx` (used) | Date picker | v8 is one major behind v9 | Yes | **KEEP or upgrade deliberately** |
| 24 | `embla-carousel-react` | `8.5.1` | `components/ui/carousel.tsx` (**ui-only, dead**) | Carousel | — | **No** | **REMOVE** (+ delete `carousel.tsx`) |
| 25 | `vaul` | `^0.9.6` | `components/ui/drawer.tsx` (**ui-only, dead**) | Drawer | — | **No** | **REMOVE** |
| 26 | `cmdk` | `1.0.4` | `components/ui/command.tsx` (**ui-only, dead**) | Command palette | — | **No** | **REMOVE** now; **re-add** when global search is built (`47_SEARCH.md`) |
| 27 | `input-otp` | `1.4.1` | `components/ui/input-otp.tsx` (**ui-only, dead**) | OTP input | — | **No** | **REMOVE** (+ verify Supabase default OTP template covers the confirm screen) |
| 28 | `sonner` | `^1.7.1` | `components/ui/sonner.tsx` (**ui-only, dead**) | Toasts | — | **No** | **REMOVE** (shadcn `toast` is the live system) |
| 29 | `react-resizable-panels` | `^2.1.7` | `components/ui/resizable.tsx` (**ui-only, dead**) | Panels | — | **No** | **REMOVE** |
| 30 | `react-error-boundary` | `^6.0.0` | **0 files** | Error boundaries | — | **No** | **REMOVE** — the repo has its own `components/error-boundary.tsx` |
| 31 | `postcss` | `^8.5` (dev) | build | CSS | — | Yes | **KEEP** |
| 32 | `autoprefixer` | `^10.4.20` (**in `dependencies`**) | via postcss | Vendor prefixes | Should be a devDependency | Yes, misfiled | **MOVE to devDependencies** |
| 33 | 24 × `@radix-ui/react-*` | pinned `1.x`/`2.x` | via `components/ui/*` | Accessible primitives | Radix is actively maintained; exact pinning is good | Yes for the 26 used | **KEEP used ones; REMOVE the 15 whose wrappers are dead** |

**Dead-wrapper Radix packages** (their only consumer, `components/ui/*.tsx`, is imported by nothing):
`react-accordion` (used), `react-alert-dialog`, `react-aspect-ratio`, `react-context-menu`,
`react-hover-card`, `react-menubar`, `react-navigation-menu`, `react-pagination`, `react-scroll-area`,
`react-toggle`, `react-toggle-group`, `react-slider` — each also pulls a transitive dependency.

---

## 2. Dev dependency audit

| Dependency | Declared | Assessment |
| --- | --- | --- |
| `typescript` | `^5.8.3` | **KEEP**, but stop ignoring build errors |
| `eslint` | `^8.57.1` | **REPLACE** with ESLint 9 to match flat config and modern plugins |
| `eslint-config-next` | `15.4.3` | **Version-mismatched** with ESLint 8; align with the chosen Next major |
| `@types/node` | `^22.16.3` | **KEEP**; add an `engines` field and `.nvmrc` |
| `@types/react`, `@types/react-dom` | `^18` | **KEEP** |

**Missing dev dependencies that a commercial SaaS requires:** `vitest` or `jest`,
`@playwright/test`, `axe-core` / `@axe-core/playwright`, `supertest`, `eslint-plugin-security`,
`eslint-plugin-import`, `prettier`, `osv-scanner` or `npm audit` in CI, `dotenv-cli`,
`pg` + `testcontainers` (or `supabase start`) for database integration tests.

---

## 3. Findings

### F-DEP-01 — `zod` declared but never used: the application has no schema contract
*Finding:* the repository declares `zod ^3.24.1` (`package.json:70`) and imports it in **zero** files.
*Evidence:* `rg "zod" -g "*.ts" -g "*.tsx"` returns no hits outside `package.json`.
Every API route hand-rolls its validation, e.g. `app/api/performances/route.ts:209-238`
(`validateRequiredFields` + a manual numeric loop), `app/api/sessions/route.ts:151-167`
(required fields + `isValidUuid`), `app/api/discord-portal/settings/route.ts:147-164`
(a hardcoded `validKeys` array).
*Impact:* validation is inconsistent, non-composable and untested; the same logical field
(`placement`, `damage`, `session_time`) is validated differently in different routes; there is
no single place to generate an OpenAPI contract or a typed client.
*Severity:* **MEDIUM** · *Confidence:* **HIGH**
*Recommendation:* V2 must define one zod schema per resource, import it in the route handler
**and** the form, and derive TypeScript types from it.

### F-DEP-02 — Nine dependencies are dead weight; six more are effectively dead
*Finding:* `@hookform/resolvers`, `react-error-boundary`, `embla-carousel-react`, `vaul`,
`cmdk`, `input-otp`, `sonner`, `react-resizable-panels`, `animejs` (+`@types/animejs`) are
imported **only** by `components/ui/*.tsx` wrappers that nothing imports — or not at all.
*Evidence:* `rg -l <pkg> -g "*.tsx"` returns exactly one file per package, and the
`components/ui` reference table in `06_UI_COMPONENTS.md` shows 0 importers for
`carousel`, `drawer`, `command`, `input-otp`, `sonner`, `resizable`, `sidebar`, `chart`, `form`.
*Impact:* install size, audit surface and upgrade cost with zero functional benefit;
undermines the credibility of the dependency list for due diligence.
*Severity:* **LOW** · *Confidence:* **HIGH**
*Recommendation:* remove, and add a CI "no unused dependency" check (`depcheck`/`knip`).

### F-DEP-03 — Two lockfiles for two package managers
*Finding:* both `pnpm-lock.yaml` (260,538 bytes) and `package-lock.json` (368,294 bytes) are
committed, while `package.json:83` declares `packageManager: pnpm@10.14.0`.
*Evidence:* repository root listing; `package.json:83`.
*Impact:* two different dependency resolutions can be produced from the same commit —
a classic supply-chain reproducibility and vulnerability-triage hazard. `build.out` also shows
a build that stalled on an interactive Corepack download prompt, i.e. the toolchain is not
self-bootstrapping in CI.
*Severity:* **MEDIUM** · *Confidence:* **HIGH**
*Recommendation:* keep exactly one lockfile; enforce `pnpm install --frozen-lockfile` in CI.

### F-DEP-04 — Unpinned runtime dependencies
*Finding:* `date-fns: "latest"` and `tesseract.js: "latest"`.
*Evidence:* `package.json:47,68`.
*Impact:* a fresh install months from now resolves to different code than what was tested; the
lockfiles mitigate this only if the correct one is used, and two lockfiles exist.
*Severity:* **MEDIUM** · *Confidence:* **HIGH**
*Recommendation:* pin exact versions; rely on Dependabot/Renovate for upgrades.

### F-DEP-05 — Client-side OCR pulls executable WASM and model data from a third-party CDN
*Finding:* `tesseract.js` is instantiated in the browser (`lib/ocr-service.ts:16-19,
39-46`) with no `workerPath`, `corePath`, `langPath` or `cacheMethod` configuration, so
Tesseract's defaults fetch the WASM core and `eng.traineddata` from a jsDelivr CDN at runtime.
*Evidence:* `lib/ocr-service.ts:16-19` `const worker = await createWorker()`; line 39
`await worker.reinitialize("eng")`; no path options anywhere in the file.
*Impact:* (a) availability dependency on a third-party CDN inside a business workflow;
(b) no Subresource Integrity / no control over what code executes in the user's session;
(c) ~10–20 MB of model download per user session; (d) heavy main-thread CPU cost on
low-end devices, which matters because players are often on mobile hardware.
*Severity:* **MEDIUM** · *Confidence:* **HIGH**
*Recommendation:* move OCR server-side with pinned model assets; see `21_OCR.md`.

### F-DEP-06 — Supabase client persists the full session (including the refresh token) in `localStorage`
*Finding:* `lib/supabase.ts:36-51` configures the browser client with
`storage: window.localStorage`, `storageKey: 'raptor-auth-token'`, `persistSession: true`,
`flowType: 'pkce'`, `detectSessionInUrl: true`.
*Evidence:* `lib/supabase.ts:41-43`.
*Impact:* any XSS in the app yields a long-lived refresh token from `localStorage`, defeating
the stated intent of `lib/session-storage.ts:1` ("Session Storage Utility - Secure token
management"), which carefully keeps the access token in memory only
(`lib/session-storage.ts:29-30, 111-113`). The two mechanisms contradict each other and the
Supabase one wins, because it is the actual session store.
*Severity:* **HIGH** · *Confidence:* **HIGH**
*Recommendation:* V2 must move the Supabase session to an `httpOnly`, `Secure`,
`SameSite=Lax` cookie handled by the server; never expose the refresh token to JavaScript.

### F-DEP-07 — No Content Security Policy, and `X-XSS-Protection` is relied on instead
*Finding:* `middleware.ts:8-13` sets `X-Frame-Options`, `X-Content-Type-Options`,
`Referrer-Policy`, `X-XSS-Protection`, `HSTS` and `Permissions-Policy` — but **no
`Content-Security-Policy`**. `X-XSS-Protection` has been removed from all modern browsers and
provides no protection.
*Evidence:* `middleware.ts:7-13`; no `Content-Security-Policy` string anywhere in the repository.
*Impact:* no defence-in-depth against the XSS class of bug that F-DEP-06 makes exploitable.
Because the app renders `dangerouslySetInnerHTML` in three places and has no CSP, an injected
script can exfiltrate the `localStorage` session.
*Severity:* **HIGH** · *Confidence:* **HIGH**
*Recommendation:* deploy a strict CSP (nonce-based), remove `X-XSS-Protection`.

### F-DEP-08 — Client bundle ships a 6.1 MB decorative video and disables image optimisation
*Finding:* `public/space-particles.mp4` = 6,399,270 bytes; `next.config.mjs:3-4`
`images: { unoptimized: true }`.
*Evidence:* file listing; `next.config.mjs:3-4`.
*Impact:* bandwidth and LCP cost on mobile; `unoptimized` disables Next's image pipeline
entirely, so avatars (Supabase-hosted) are served at source resolution.
*Severity:* **MEDIUM** · *Confidence:* **HIGH**
*Recommendation:* CDN + adaptive video; re-enable `next/image` with a remote `loader` for
Supabase Storage.

---

## 4. Dependency risk summary

| Category | Count | Notes |
| --- | --- | --- |
| Unused / dead | 9 direct + ~15 transitive | See `02_FILE_INVENTORY.md` §3 |
| Unpinned | 2 | `date-fns`, `tesseract.js` |
| Version-mismatched | 2 | ESLint 8 vs `eslint-config-next` 15; Next 14 vs React 18 support matrix |
| Framework advisory exposure | 1 | `next ^14.2.30` + unmerged `vercel/react-server-components-cve-*` branch |
| Security-relevant design choices | 3 | `localStorage` session, no CSP, CDN-loaded WASM |
| Missing entirely (needed for SaaS) | ~10 | test runner, E2E, a11y testing, security linting, dependency scanning, formatter, DB test harness |
| Total declared | 68 | 60 runtime + 8 dev |
