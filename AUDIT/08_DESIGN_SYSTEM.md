# 08 - DESIGN SYSTEM AUDIT
**Audit.md section:** 11 (SECTION 08)
**Rule observed:** *do not redesign, document problems for V2.* Nothing was changed.

## 1. What exists

| Element | Implementation | Location |
| --- | --- | --- |
| Component primitives | 20 shadcn/ui + Radix components | `components/ui/` |
| Token layer | 40 CSS custom properties in HSL triplets, `:root` + `.dark` | `app/globals.css:16-87` |
| Token bridge | `tailwind.config.ts` maps every token to `hsl(var(--x))` | `tailwind.config.ts` |
| Border radius | 1 token (`--radius: 0.5rem`) with `lg/md/sm` derived by subtraction | `tailwind.config.ts`, `globals.css:44` |
| Typography | Orbitron (900, uppercase, `letter-spacing: 0.04em`) for all headings; Arial for body | `globals.css:4, 7, 153-158` |
| Spacing | Tailwind default scale only - **no custom scale, no tokens** | `tailwind.config.ts` |
| Breakpoints | Tailwind defaults only (`sm 640 / md 768 / lg 1024 / xl 1280`) plus two ad-hoc media queries | `globals.css:112, 137` |
| Icons | Lucide React, plus ~51 inline SVG literals in components | `package.json`, `app/dashboard/page.tsx` |
| Dark mode | `darkMode: ["class"]` | `tailwind.config.ts:5` |
| Global CSS size | **492 lines**, of which ~300 are `!important` override rules | `app/globals.css` |

**This is a competent shadcn/ui setup.** The token layer is real, the primitives are the right
ones, and Radix is used properly. The problem is not the foundation - it is what was layered on
top of it.

## 2. Findings

### DS-01 - The token system is bypassed on the pages that matter - CRITICAL for V2
**Finding:** ~500 raw Tailwind colour utilities are used across the app, concentrated on the
highest-traffic pages, bypassing the token layer entirely.

**Evidence** - raw colour utilities per file:

| File | Raw colour utilities |
| --- | --- |
| `app/dashboard/page.tsx` | **107** |
| `components/dashboard/role-based-dashboard.tsx` | 49 |
| `components/attendance/enhanced-mark-attendance.tsx` | 43 |
| `components/attendance/session-attendance.tsx` | 33 |
| `components/attendance/attendance-logs.tsx` | 33 |
| `components/profile/bgmi-gaming-section.tsx` | 25 |
| `app/dashboard/analytics/page.tsx` | 24 |
| `app/global-error.tsx` | 23 |
| `components/attendance/daily-practice-attendance.tsx` | 22 |
| `app/auth/signup/page.tsx` | 21 |
| 15 further files | 17-19 each |

Plus **51 raw hex literals** in components.

**Impact:** the token layer is decorative. Changing `--primary` would restyle the primitives and
leave the dashboard, all attendance screens, analytics, signup and the error boundary untouched.
**White label is therefore impossible** (`80_WHITE_LABEL.md`), and no theme can be corrected
consistently.

**Confidence:** HIGH.

**Recommendation for V2:** forbid raw colour utilities in application code via an ESLint rule or a
stylelint restriction; every colour must resolve to a semantic token. This is a prerequisite for
`80_WHITE_LABEL.md`, not a cosmetic improvement.

---

### DS-02 - Light mode is structurally impossible - HIGH
**Finding:** the dashboard forces white text on every child element with `!important`, and
overrides every background utility to a translucent white.

**Evidence** (`app/globals.css:161-300`):
```css
.dashboard-content h1 ... h6 { color: white !important; }
.dashboard-content .bg-white { background-color: rgba(255,255,255,0.05) !important;
                              backdrop-filter: blur(16px) !important; }
.dashboard-content .bg-card { background-color: rgba(255,255,255,0.06) !important; ... }
.dashboard-content button { color: white !important; }
```
Roughly 300 lines of `.dashboard-content * { color: white !important }` rules, covering headings,
paragraphs, buttons, inputs, selects, textareas, tabs, cards, badges and shadows.

**Impact:** there is no light theme for the application, only for the marketing pages. The token
system declares a full light palette that the product never uses. Any attempt to add light mode or
a customer-selectable theme would require deleting this override block and fixing every page.

**Confidence:** HIGH.

**Recommendation for V2:** remove the `!important` layer; express the dashboard's dark surface as
a token (`--surface-glass`, `--surface-glass-border`, `--text-on-glass`) so it becomes a theme
rather than a hardcoded skin.

---

### DS-03 - Colour semantics are undefined - HIGH
**Finding:** the palette has no semantic colour roles, so status cannot be communicated
consistently.

**Evidence:** the token set is `primary / secondary / muted / accent / destructive` plus
`chart-1..5`. There is **no** `success`, `warning`, `info`, or `pending` token.

**Impact:** across attendance (present / absent / late / excused), tryouts (6+ statuses), finance
(paid / unpaid / overdue), contracts (draft / sent / accepted / expired) and sponsorship
(obligation status), the same semantic state is rendered in a different arbitrary colour in each
screen. Users must learn colour by screen rather than by meaning, and colour-blind users are
worse off still.

**Confidence:** HIGH.

**Recommendation for V2:** add semantic status tokens (`success`, `warning`, `danger`, `info`,
`neutral`) plus an elevation scale, and map every domain status to them. Status must always carry
a text label or icon, never colour alone (`57_ACCESSIBILITY.md`).

---

### DS-04 - `!important` as the layout mechanism - HIGH
**Finding:** specificity is escalated rather than resolved, in both directions.

**Evidence:** ~300 lines of `!important` in `globals.css`; a `[class*="bg-card"]` attribute
selector (`:195`) to match a class substring; two selectors for the same button variant
(`button[data-variant="outline"]` **and** `.variant-outline`, `:229-231`); and
`.dashboard-content .text-gray-600 ... .text-gray-900` (`:170-178`) overriding four Tailwind
greys at once.

**Impact:** overrides are effectively irreversible without `!important`, so fixes accumulate as
more overrides. Any V2 component that must look different inside the dashboard has no sanctioned
mechanism. This is the direct cause of DS-02 and DS-03 persisting.

**Confidence:** HIGH.

**Recommendation for V2:** zero `!important` in application styling; container-scoped theming via
a CSS layer or a variant prop on the primitives, not by overriding internals.

---

### DS-05 - Typography is two systems that disagree - MEDIUM
**Finding:** three font declarations and no type scale.

**Evidence:**
* `globals.css:4` - `@import` Orbitron from Google Fonts, **after** the three `@tailwind`
  directives. CSS requires all `@import` statements before other rules, so this import is
  **invalid** and browsers may drop it.
* `globals.css:7` - `body { font-family: Arial, Helvetica, sans-serif; }`
* `globals.css:153` - headings use `Orbitron, Arial, sans-serif`, weight 900, uppercase,
  `letter-spacing: 0.04em`.
* `globals.css:111-119` - `h1/h2/h3` font sizes redefined inside a single `max-width: 640px`
  media query.
* No `fontSize`, `fontFamily` or `lineHeight` extension in `tailwind.config.ts` - the default
  Tailwind scale is used unmodified.

**Impact:** the intended display font may not load at all (invalid `@import` position), so
headings silently fall back to Arial in a heavier, wider, uppercase form. There is no type scale,
so heading sizes vary by utility class rather than by role. Uppercase Orbitron on every heading,
including long form labels, is a legibility and readability cost.

**Confidence:** HIGH for the invalid `@import` and the missing scale; MEDIUM for whether the font
loads in production (depends on the build's CSS handling).

**Recommendation for V2:** move the font to `next/font` (self-hosted, no render-blocking
third-party request, no `@import` ordering problem); define a real type scale; and reserve the
display face for headings and numerals, not for all-caps body copy.

---

### DS-06 - No spacing scale or layout primitives - MEDIUM
**Finding:** spacing is entirely Tailwind defaults; there are no layout tokens, no container
widths, no density modes and no elevation scale.

**Evidence:** `tailwind.config.ts` `theme.extend` contains only `colors`, `borderRadius`,
`keyframes` and `animation`. No `spacing`, `fontSize`, `screens`, `boxShadow` or `maxWidth`.

**Impact:** information density cannot be tuned per tenant or per screen - which matters directly
for the dense tables in `58_MOBILE.md`. Shadows are Tailwind defaults except inside the dashboard,
where they are overridden to a single hardcoded value. Radii are derived by subtraction from one
token, so a radius change silently alters every derived size.

**Confidence:** HIGH.

**Recommendation for V2:** add an explicit spacing scale, an elevation scale, container widths, and
a density mode (comfortable/compact) for data tables. Keep `--radius` as a base and derive
explicitly rather than by arithmetic.

---

### DS-07 - Icons are inconsistent and partly hand-drawn - LOW
**Finding:** Lucide React is installed, but ~51 inline SVG literals remain in components, including
in `app/dashboard/page.tsx` and `app/global-error.tsx`.

**Impact:** inconsistent stroke widths and sizes, duplicated icons, and no single place to change
iconography. Minor in severity, but a sign that the primitive library was adopted without a
cleanup pass.

**Confidence:** HIGH. **Recommendation for V2:** one icon source, one size scale, no inline SVG in
application code.

---

### DS-08 - Component consistency gaps - MEDIUM
**Finding:** the same UI is built several times over.

**Evidence** (`06_UI_COMPONENTS.md`, `44_WORKFLOWS.md`): 4 attendance components with overlapping
responsibility (`enhanced-mark-attendance`, `session-attendance`, `attendance-logs`,
`daily-practice-attendance`); 5 separate performance entry forms; 2 `PerformanceModule`
instances at 56 KB and 60 KB; 27 of 51 UI components unreferenced; 7 dark-only placeholder pages.

**Impact:** design inconsistency is a symptom, not the disease - the same concepts have multiple
implementations, so they drift in markup, colour, spacing and behaviour. The variant selector
duplication in DS-04 is direct evidence of this drift.

**Confidence:** HIGH. **Recommendation for V2:** one component per concept, with variants, before
any visual work.

---

### DS-09 - Accessibility consequences of the token layer - HIGH
**Finding:** the palette is untested for contrast, and dark mode is only reachable by
`class`-toggling.

**Evidence:** `--muted-foreground: 0 0% 45.1%` on `--background: 0 0% 100%` in light mode, and
`0 0% 63.9%` on `0 0% 3.9%` in dark; the dashboard replaces all of it with `rgba(255,255,255,0.6)`
to `0.9` over a translucent card. `globals.css:102-104` forces `min-height: 44px` on all inputs
(touch targets - correct) but nothing else is specified.

**Impact:** muted text on the glass dashboard is the most common body text in the product and its
contrast is unverified. Colour-only status (DS-03) is an additional WCAG 1.4.1 risk. No evidence of
any contrast testing exists.

**Confidence:** MEDIUM - the values are read from source; actual rendered contrast depends on the
composited backdrop.

**Recommendation for V2:** automated contrast testing in CI against composited backgrounds, status
never conveyed by colour alone, and a documented focus-ring token (DS-04 makes the current ring
overridden inside the dashboard).

---

## 3. V2 design-system requirements

Recorded here as requirements only. No redesign was performed, per Audit.md §11.

1. **Tokens are mandatory and enforced.** No raw colour utility and no hex literal in application
   code; enforced by lint. A colour that cannot be named is a colour that is not designed.
2. **Three token layers:** primitive (the palette) -> semantic (intent: `text-muted`,
   `surface-raised`, `danger`) -> component (only where a component genuinely needs an exception).
3. **A real type scale** with a self-hosted display font, a body face, and a numeral treatment for
   statistics and money.
4. **A spacing scale, an elevation scale and a density mode** for data-dense tables.
5. **A status palette** (`success / warning / danger / info / neutral`) mapped to every domain
   status, always paired with a text label.
6. **Light and dark as equal themes**, with no `!important` overrides and no per-container
   re-colouring.
7. **Theming must be tenant-scoped** - the prerequisite for `80_WHITE_LABEL.md`: tokens resolve
   from a tenant theme object, not from a global stylesheet.
8. **Accessibility gates in CI:** contrast on composited backgrounds, focus visibility, and
   automated axe checks on every route.
9. **One component per concept**, with variants, and a documented deprecation path for the 27
   dead components (`06_UI_COMPONENTS.md`).
10. **A documented design-system contribution rule** - the failure mode that produced 500 raw
    colour utilities is an unrecorded decision, not a lack of skill.

## 4. Verdict
**The foundation is sound; the application layer abandoned it.** A correct shadcn/Radix token
system exists and is then overridden by ~300 lines of `!important` rules and ~500 raw colour
utilities, which is why the product is dark-only, why white label is impossible, and why the same
UI exists in five variants. This is a **usage problem, not a foundation problem** - which is
unusual and good news: the V2 design system can start from the existing token layer and add
discipline, rather than starting from nothing.
