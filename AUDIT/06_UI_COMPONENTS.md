# 06 — UI COMPONENT AUDIT

**Audit.md section:** 10 (SECTION 07 — UI COMPONENT AUDIT)
**Related:** `AUDIT_DESIGN_SYSTEM.md` (Audit.md §11 / SECTION 08 — DESIGN SYSTEM AUDIT).

---

## 1. Component inventory (98 files)

### 1.1 Layout & shell
| Component | Path | Size | Consumers | Status |
| --- | --- | --- | --- | --- |
| Root layout | `app/layout.tsx` | 2,341 | framework | active |
| Dashboard layout | `app/dashboard/layout.tsx` | 413 | framework | active |
| `NewDashboardLayout` | `components/dashboard/new-dashboard-layout.tsx` | 13,587 | `app/dashboard/layout.tsx` | active |
| `RoleBasedDashboard` | `components/dashboard/role-based-dashboard.tsx` | 19,474 | — | **UNUSED** (duplicate of the layout's role switching) |
| `DashboardContentWrapper` | `components/dashboard/dashboard-content-wrapper.tsx` | 310 | — | **UNUSED** |
| `PublicNavigation` / `PublicHeader` / `PublicFooter` / `public-theme` | `components/public/*` | 963 / 476 / 3,526 / 363 | public pages, `error.tsx`, `not-found.tsx` | active |
| `VideoBackground` | `components/video-background.tsx` | 682 | many public pages + error boundaries | active |
| `ThemeProvider` | `components/theme-provider.tsx` | 303 | `app/layout.tsx` | active (trivial next-themes wrapper) |

### 1.2 Navigation
There is **no dedicated navigation component library**. Navigation is:
* `DASHBOARD_MODULES` in `lib/dashboard-permissions.ts:28-159` — a data array of 13 modules
  with `{id,title,description,icon,path,allowedRoles,showInNavigation,mobileOrder}` consumed
  by `new-dashboard-layout.tsx` for both desktop sidebar and mobile navigation.
* `components/ui/sidebar.tsx` (25,083 bytes — the largest UI primitive) is **NEVER IMPORTED**.
* `components/ui/breadcrumb.tsx`, `menubar.tsx`, `navigation-menu.tsx` — **NEVER IMPORTED**.

**Finding — the largest navigation primitive in the repository is dead code, and navigation is
data-driven from a permission array that duplicates the role model a second time.**
*Evidence:* `components/ui/sidebar.tsx` (25,083 B) has 0 importers;
`DASHBOARD_MODULES` in `lib/dashboard-permissions.ts:28-159` is the real navigation source and
declares its own `allowedRoles` per module, independent of `ROLE_CONFIG` in
`lib/role-system.ts` and independent of the database `module_permissions` table (which is
never queried).
*Impact:* adding a role or changing a permission requires editing up to four disconnected
places, and they already disagree (e.g. `DASHBOARD_MODULES` includes `awaiting_approval` as a
valid `UserRole` at `lib/dashboard-permissions.ts:6`, but the database `users.role` CHECK
constraint in `scripts/00-complete-schema-setup.sql:43` does **not** allow that value).
*Severity:* **MEDIUM** · *Confidence:* **HIGH*
*Recommendation:* single permission source of truth (see `63_ROLE_MODEL.md`).

### 1.3 Forms — **hand-rolled; the form library is dead**
| Component | Path | Size | Consumers | Status |
| --- | --- | --- | --- | --- |
| `Form`, `FormField`, `FormItem`, `FormLabel`, `FormControl`, `FormDescription`, `FormMessage`, `useFormField` | `components/ui/form.tsx` | 4,277 | **0** | **DEAD** |
| `Input` | `components/ui/input.tsx` | 813 | 23 files | active |
| `Textarea` | `components/ui/textarea.tsx` | 711 | 10 files | active |
| `Select` | `components/ui/select.tsx` | 5,802 | 29 files | active |
| `Checkbox` | `components/ui/checkbox.tsx` | 1,117 | 3 files | active |
| `RadioGroup` | `components/ui/radio-group.tsx` | 1,525 | 2 files | active |
| `Switch` | `components/ui/switch.tsx` | 1,182 | 4 files | active |
| `Slider` | `components/ui/slider.tsx` | 1,119 | 0 | **DEAD** |
| `InputOTP` | `components/ui/input-otp.tsx` | 2,239 | 0 | **DEAD** |
| `Calendar` | `components/ui/calendar.tsx` | 2,653 | 2 files | active |

**Finding — no page uses `react-hook-form`; every form is local `useState` + manual validation.**
*Evidence:* `rg "useForm"` returns hits only inside `components/ui/form.tsx` (lines 12-13, 44-52);
`react-hook-form` is declared at `package.json:61` and `@hookform/resolvers` at line 12 with
zero importers. Forms such as `components/performance/enhanced-player-performance-submit.tsx`
(22,374 B) manage their own field state, error state and submit state by hand.
*Impact:* inconsistent validation, no shared error display contract, no schema sharing between
UI and API, high defect surface in exactly the workflows that matter (performance entry,
attendance marking, tryout evaluation, finance).
*Severity:* **HIGH** (quality) · *Confidence:* **HIGH*
*Recommendation:* V2 standardises on RHF + zod resolvers with a single `<FormField>` contract;
delete all bespoke form state machines.

### 1.4 Tables
| Component | Path | Consumers | Status |
| --- | --- | --- | --- |
| `Table` (+ `TableHeader`, `TableBody`, `TableRow`, `TableCell`, `TableCaption`, `TableFooter`) | `components/ui/table.tsx` (3,052 B) | 11 files | active |
| Ad-hoc `<table>` markup | `app/dashboard/user-management/page.tsx`, `app/dashboard/team-management/roster/page.tsx`, `app/dashboard/team-management/slots/page.tsx`, `app/dashboard/discord-portal/logs/page.tsx`, `components/discord-portal/send-to-discord-button.tsx` | — | **DUPLICATE** of the primitive |

Recent commits (`42ab838 Improve table responsiveness with whitespace and truncation classes`,
`bd0b3a3 Improve user management table layout and responsiveness`) show responsiveness being
patched per-table rather than solved in the primitive — evidence of the duplication cost.

### 1.5 Cards, dialogs, alerts, toasts, loading, error
| Component | Path | Consumers | Status |
| --- | --- | --- | --- |
| `Card` family | `components/ui/card.tsx` | 52 files | active — most used primitive |
| `Dialog` | `components/ui/dialog.tsx` | 5 files | active |
| `AlertDialog` | `components/ui/alert-dialog.tsx` | 0 | **DEAD** — yet destructive actions (purge data, delete webhook) use plain `Dialog` or no confirmation at all |
| `Sheet` | `components/ui/sheet.tsx` | 1 (`PublicNavigation.tsx`) | active |
| `Drawer` | `components/ui/drawer.tsx` | 0 | **DEAD** |
| `Alert` | `components/ui/alert.tsx` | 13 files | active |
| `Toast` / `Toaster` / `use-toast` | `components/ui/toast.tsx`, `toaster.tsx`, `hooks/use-toast.ts` | many | active |
| `Sonner` | `components/ui/sonner.tsx` | 0 | **DEAD** — dependency `sonner` also unused |
| `Skeleton` | `components/ui/skeleton.tsx` | 0 | **DEAD** — every page uses spinners/`isLoading` text instead |
| `Progress` | `components/ui/progress.tsx` | 2 files | active |
| `GlobalLoading` | `components/ui/global-loading.tsx` | `app/layout.tsx` | active |
| `ErrorBoundary` | `components/error-boundary.tsx` | root layout | active |
| `LoadingErrorBoundary` | `components/loading-error-boundary.tsx` | root layout | active |
| `Badge` | `components/ui/badge.tsx` | 27 files | active |
| `Tooltip` | `components/ui/tooltip.tsx` | 1 file | active |
| `Tabs` / `EnhancedTabs` / `ResponsiveTabs` | `components/ui/tabs.tsx`, `enhanced-tabs.tsx` (14,908 B), `responsive-tabs.tsx` | 4 / 6 / 0 | `ResponsiveTabs` **DEAD**; `EnhancedTabs` is a 3× larger parallel implementation |
| `Accordion` | `components/ui/accordion.tsx` | 1 file | active |
| `CountUp` | `components/ui/count-up.tsx` | 1 file | active |
| `FadeInOnScroll` | `components/ui/fade-in-on-scroll.tsx` | 6 files | active |
| `ResponsiveFilters` / `ResponsiveGrid` | `components/ui/*` | 0 / 0 | **DEAD** |
| `Command` (cmdk) | `components/ui/command.tsx` | 0 | **DEAD** — would be the basis for global search |
| `Chart` (Recharts wrapper) | `components/ui/chart.tsx` (11,318 B) | 0 | **DEAD** — charts are hand-rolled in `advanced-charts.tsx` |

### 1.6 Domain components
| Area | Components | Notes |
| --- | --- | --- |
| Attendance | 12 components, 172 KB total | `mark-attendance` vs `enhanced-mark-attendance`; `session-attendance` vs `training-session-attendance` vs `scrim-attendance` vs `daily-practice-attendance`; `attendance-stats` vs `attendance-logs` vs `manager-verification`; `practice-session-config` (22,382 B); `daily-session-manager` (24,894 B) |
| Performance | 9 components, 142 KB | **5 submit forms**; `ocr-extract.tsx` (19,547 B); `smart-slot-selector.tsx` (21,615 B); `performance-dashboard.tsx`; `performance-report-simple.tsx` |
| Profile | 5 components, 82 KB | `profile-sections.tsx` 32,502 B; `bgmi-gaming-section.tsx` 15,783 B; `profile-search.tsx` 12,996 B; `avatar-upload.tsx`; `profile-header.tsx` |
| Analytics | 2 components, 37 KB | `analytics-sections.tsx` 27,939 B; `advanced-charts.tsx` 8,844 B |
| Discord portal | 1 component, 19 KB | `send-to-discord-button.tsx` |
| Session | 2 components | `idle-timer.tsx` (5,137 B), `token-refresher.tsx` (3,467 B) |
| SEO | 1 | `OrganizationJsonLd.tsx` |
| Route guard | 1 | `route-guard-v2.tsx` |

---

## 2. Duplication findings

### F-UI-01 — 29 of 55 shadcn/ui primitives are never imported
*Evidence:* reference-count table in `06_UI_COMPONENTS.md` / reproduced in
`02_FILE_INVENTORY.md` §2.3. Dead: `accordion` is used, but `alert-dialog`, `aspect-ratio`,
`breadcrumb`, `carousel`, `chart`, `collapsible`, `command`, `context-menu`, `drawer`,
`dropdown-menu`, `form`, `hover-card`, `input-otp`, `menubar`, `navigation-menu`, `pagination`,
`resizable`, `responsive-filters`, `responsive-grid`, `responsive-tabs`, `scroll-area`,
`sidebar`, `skeleton`, `slider`, `sonner`, `toggle`, `toggle-group` = **27 dead**, plus
`alert` and `tooltip` at only 1 consumer each.
*Impact:* ~110 KB of unmaintained component code plus 20+ transitive Radix packages; a
reviewer cannot tell which components represent the intended design system.
*Severity:* **LOW** · *Confidence:* **HIGH*
*Recommendation:* **REMOVE** the 27; keep the 26 that are used plus the two needed for V2
(`form`, `command`, `alert-dialog`, `sidebar`, `dropdown-menu`).

### F-UI-02 — Two parallel tab implementations and two parallel table implementations
*Evidence:* `components/ui/tabs.tsx` (1,952 B, 4 consumers) vs
`components/ui/enhanced-tabs.tsx` (14,908 B, 6 consumers) vs
`components/ui/responsive-tabs.tsx` (5,363 B, 0 consumers);
`components/ui/table.tsx` (3,052 B, 11 consumers) vs raw `<table>` markup in at least 5 files.
*Impact:* inconsistent tab/table behaviour and spacing across the product; fixes must be
applied in multiple places.
*Severity:* **MEDIUM** · *Confidence:* **HIGH*
*Recommendation:* keep one of each, extended with the responsive behaviour the others attempt.

### F-UI-03 — Five performance-entry forms and twelve attendance components
*Evidence:* see §1.6. `PERFORMANCE_PAGE_CONSOLIDATION.md` (6,096 B, repository root)
documents an unfinished consolidation.
*Impact:* the highest-value operational workflows have the widest defect surface. The
attendance bug documentation (`APPLY_ATTENDANCE_FIX.md`, `DEBUG_ATTENDANCE_ISSUE.md`,
`comprehensive_attendance_debug.sql`, `investigate_existing_attendance.sql`) is consistent with
five components disagreeing about session identity, `slot` vs `slot_id`, and cutoff time.
*Severity:* **HIGH** · *Confidence:* **HIGH*
*Recommendation:* **REBUILD** both surfaces once each, driven by a session-type discriminator
and a single attendance state machine.

### F-UI-04 — Skeleton loaders exist but are unused; three loading mechanisms coexist
*Evidence:* `components/ui/skeleton.tsx` (276 B) has 0 importers; `lib/global-loading-manager.tsx`
(7,935 B) + `components/ui/global-loading.tsx` (5,747 B) + per-page `isLoading` booleans.
`app/dashboard/layout.tsx:10` comment: *"Remove duplicate loading logic - let NewDashboardLayout handle it"*.
*Impact:* inconsistent perceived performance; no layout-shift control; no route-level streaming.
*Severity:* **MEDIUM** · *Confidence:* **HIGH*
*Recommendation:* one loading model (Suspense + skeletons per route segment).

### F-UI-05 — Destructive actions lack a confirmation primitive
*Evidence:* `components/ui/alert-dialog.tsx` (4,575 B) is **never imported**. The purge-all-data
control lives in `app/dashboard/admin/settings/page.tsx`; webhook deletion in
`app/dashboard/discord-portal/webhooks/page.tsx`; attendance deletion via `DELETE /api/attendances`
(which is itself broken). `lib/force-logout.ts:48-65` builds a toast by assigning
`toast.innerHTML = \`...${reason}...\`` — an **HTML injection sink** if `reason` is ever
attacker-influenced.
*Severity:* **HIGH** (data loss) / **LOW** (innerHTML reachability today) · *Confidence:* **HIGH** for the missing confirmation, **MEDIUM** for the innerHTML reachability
*Recommendation:* require `AlertDialog` + typed confirmation for every destructive action; never
interpolate untrusted strings into `innerHTML`.

---

## 3. Inconsistent patterns observed

| Pattern inconsistency | Example A | Example B |
| --- | --- | --- |
| Button styling | shadcn `Button variant=…` (52 files) | `getButtonStyle('primary')` from `lib/global-theme.ts` returning hardcoded class strings (`app/error.tsx:79`, `app/not-found.tsx:22`, all public pages) |
| Page shell | `NewDashboardLayout` for `/dashboard/**` | bespoke `VideoBackground` + `PublicNavigation` for public pages **and** for the root error/not-found boundaries |
| Data fetching | `fetch('/api/x')` + `useState` + `useEffect` (most pages) | `lib/optimized-data-service.ts` / `lib/dashboard-data.ts` helper layers (some pages) |
| Toasts | shadcn `useToast()` (most) | `lib/force-logout.ts` raw DOM toast |
| Theme | shadcn CSS variables + `next-themes` | `lib/global-theme.ts` hardcoded class map; `components/public/public-theme.ts` |
| Colour language | Raptor brand purple/blue gradients in `lib/global-theme.ts` | `bg-white/10 backdrop-blur-md border-white/20` glassmorphism repeated inline in ~30 places (e.g. `app/error.tsx:38`, `app/dashboard/admin/settings/page.tsx:270`) |
| Form validation | manual per component | `lib/api-utils.ts:197-224` `validateRequiredFields` / `isValidUuid` on the server — no shared schema |
| Empty state | bespoke per page | no shared `<EmptyState>` primitive (there is no such component) |

---

## 4. UI component verdict for V2

| Verdict | Items |
| --- | --- |
| **KEEP** | The 26 actively used shadcn/Radix primitives (`button`, `card`, `input`, `select`, `label`, `badge`, `table`, `dialog`, `alert`, `textarea`, `switch`, `tabs`, `checkbox`, `popover`, `progress`, `avatar`, `calendar`, `separator`, `radio-group`, `toast`, `toaster`, `accordion`, `sheet`, `tooltip`, `skeleton`, `global-loading`), plus `video-background` and `public-theme` as inspiration only |
| **REBUILD** | Attendance surface, performance-entry surface, dashboard shell, navigation, forms, loading model, empty/error states, destructive-action patterns |
| **MERGE** | `tabs` + `enhanced-tabs` → one; raw `<table>` markup → `table.tsx`; `getButtonStyle` + `Button` variants → one button system |
| **REMOVE** | 27 unused shadcn primitives; 5 performance forms (keep 0, rebuild 1); 12 attendance components (keep 0, rebuild 1); `RoleBasedDashboard`; `DashboardContentWrapper`; `page.tsx.backup`; both debug pages |
| **RESEARCH FURTHER** | Whether the Recharts-based `chart.tsx` wrapper should be adopted (currently dead while charts are hand-rolled) |
