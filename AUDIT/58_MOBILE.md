# 62 - MOBILE
**Audit.md section:** 65 (SECTION 62 - MOBILE)

**Method:** static review of responsive behaviour, breakpoints, touch targets and interaction
patterns. No device testing was performed, so findings are indicative.

## 1. What is right
* Tailwind's default responsive prefixes are used throughout; several components were explicitly
  made responsive in recent commits (`42ab838 Improve table responsiveness with whitespace and
  truncation classes`, `bd0b3a3 Improve user management table layout and responsiveness`,
  `3df2ca9 Refine responsive styles for navigation and table components`,
  `bcc1690 Refactor UI components with consistent sizing and layout classes`).
* `hooks/use-mobile.tsx` (584 B) provides a `useIsMobile()` hook.
* `components/ui/responsive-tabs.tsx`, `responsive-grid.tsx`, `responsive-filters.tsx` exist —
  **but all three are dead code** (0 importers).
* `app/error.tsx` and `app/not-found.tsx` use `grid-cols-1 sm:grid-cols-2`, which is correct.
* `DASHBOARD_MODULES.mobileOrder` (`lib/dashboard-permissions.ts:36, 47, …`) shows mobile
  navigation ordering was considered.

## 2. Findings

### F-MOB-01 - HIGH: the largest surface in the product is a 60 KB monolithic client page
**Evidence.** `app/dashboard/page.tsx` — 60,575 bytes, `'use client'`, fetching 5+ endpoints and
rendering overview metrics, team lists, match lists and quick actions in one component tree.
`app/dashboard/finance/page.tsx` — 50,355 bytes. `app/dashboard/performance/page.tsx` — 34,503
bytes hosting 5 competing forms. `app/dashboard/team-management/tiers/page.tsx` — 31,630 bytes.
**Impact:** these pages ship a very large JS payload and a very deep render tree. On a
mid-range Android device - the most likely device for this user base - this is the difference
between a usable and an unusable product. It also makes every responsive fix a manual edit in a
50-60 KB file.
**Severity:** HIGH | **Confidence:** HIGH

### F-MOB-02 - HIGH: no design system for data-dense mobile layouts
**Evidence.** tables are used in 11 files via `components/ui/table.tsx` and as raw markup in at
least 5 more; there is no card-on-mobile pattern in any primitive; the responsive fixes were
applied per-page in commits rather than in the primitive.
**Impact:** wide tables either overflow horizontally (unusable) or are truncated with
`whitespace-nowrap` + `truncate` (losing information without any affordance). Attendance,
roster, finance and user-management tables are exactly the wrong shape for a phone.
**Severity:** HIGH | **Confidence:** MEDIUM
**Recommendation:** a responsive data-grid pattern (progressive disclosure to cards, or a
column-picker) as a design-system primitive, plus horizontal scroll with a sticky first column as
the minimum.

### F-MOB-03 - MEDIUM: the responsive primitives that were built are unused
**Evidence.** `components/ui/responsive-filters.tsx` (5,137 B), `responsive-grid.tsx` (4,450 B),
`responsive-tabs.tsx` (5,363 B) — all 0 importers.
**Impact:** an earlier attempt at responsive components was abandoned, and the pattern was never
replaced. This is the same dead-code pattern documented in `06_UI_COMPONENTS.md`.
**Severity:** MEDIUM | **Confidence:** HIGH

### F-MOB-04 - MEDIUM: 6.1 MB autoplaying video on every public page
**Evidence.** `public/space-particles.mp4` (6,399,270 B) via `components/video-background.tsx`,
which wraps every public page and both error boundaries.
**Impact:** on a mobile connection this is the single largest asset in the product and it is
decorative. It dominates LCP and data consumption, and it is not gated on
`prefers-reduced-data` or connection quality.
**Severity:** MEDIUM | **Confidence:** HIGH

### F-MOB-05 - MEDIUM: JS-driven layout conditionals
**Evidence.** `hooks/use-mobile.tsx` uses a JS media query; `next.config.mjs:3-4` disables image
optimisation, so no responsive `srcset` is generated for avatars.
**Impact:** conditional rendering based on a JS breakpoint causes hydration mismatch and a
flash of the wrong layout; and avatars are served at full resolution on every device.
**Severity:** MEDIUM | **Confidence:** HIGH
**Recommendation:** CSS-first responsive design; container queries; re-enable `next/image`.

### F-MOB-06 - MEDIUM: no offline or poor-connection behaviour
**Evidence.** absence of a service worker, `manifest.json`, or any caching layer
(`app/globals.css` and `next.config.mjs` contain no PWA configuration; no `next-pwa` dependency).
**Impact:** a player on a train with poor connectivity cannot see today's schedule or mark
attendance — precisely the moments when they need it.
**Severity:** MEDIUM | **Confidence:** HIGH

### F-MOB-07 - LOW: touch targets are not systematically enforced
**Evidence.** no `min-h-[44px]` / minimum-size token in `tailwind.config.ts`; buttons use default
sizes (`components/ui/button.tsx` variants `default`, `sm`, `lg`, `icon` with no documented
minimum hit area); the icon-only button variant has no enforced size floor.
**Impact:** small hit targets in dense tables and icon-only action rows.
**Severity:** LOW | **Confidence:** MEDIUM
**Recommendation:** a 44x44 CSS-pixel minimum for all interactive targets, enforced in the
button and icon-button primitives.

## 3. Mobile suitability of each major workflow
| Workflow | Mobile suitability | Blocking issue |
| --- | --- | --- |
| Sign in / sign up | Good | — |
| OTP confirm | Probably poor | 13.7 KB hand-rolled OTP; no `autocomplete="one-time-code"`, no per-digit labelling |
| Onboarding | **Poor** | 32.5 KB form component; device/sensitivity/emergency-contact fields on one long page |
| Dashboard | **Poor** | 60 KB monolith; data-dense tables |
| Team management | Poor | dense tables; `tiers/page.tsx` 31.6 KB |
| Player management | **Poor** | wide `select('*')` user table |
| Performance submission | Poor | 5 competing forms, each with map and slot selectors on a phone |
| Attendance marking | **Poor** | the most-used field workflow, in 12 overlapping desktop-first components |
| Tryouts (public application) | Good | a single form |
| Tryouts (staff) | Poor | dense tables |
| Finance | **Poor** | 50 KB page with monetary tables |
| Discord portal | Poor | webhook management tables |
| Admin settings | **Poor** | hosts the purge control behind no confirmation |
| Public marketing pages | Acceptable, but the 6.1 MB video dominates |

**Assessment:** the product is **desktop-first and not mobile-ready**. For an esports audience
that is very often on a phone, this is a significant product-level problem, not just a UI defect.

## 4. V2 mobile requirements
1. **Mobile-first design system**: a responsive data-grid primitive, a bottom navigation model for
   the top-level IA, and a sheet/drawer pattern for detail views.
2. **A bundle budget** enforced in CI; code-split every route; no page above a defined size.
3. **Server-side data loading with streaming** so the first paint does not wait for five fetches.
4. **Offline-tolerant** read for schedule and attendance; queued writes with sync.
5. **Touch targets** >= 44 CSS px, enforced in primitives.
6. **Media policy**: no autoplay above a size threshold; poster images; `prefers-reduced-motion`
   and `prefers-reduced-data` honoured.
7. **Re-enable `next/image`** with a Supabase `loader`.
8. **Real-device testing** on low-end Android as a release gate, covering the attendance and
   performance-submission workflows specifically.

## 5. Verdict
**REBUILD the responsive strategy.** Desktop-first assumptions are embedded in the component
structure, the two largest pages are monoliths, and the mobile audience is the primary one.
