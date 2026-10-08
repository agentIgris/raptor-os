# 61 - ACCESSIBILITY
**Audit.md section:** 64 (SECTION 61 - ACCESSIBILITY)

**Method:** static review of semantic structure, focus management, labelling, contrast decisions
and motion. No automated axe/Lighthouse run was performed and no assistive-technology testing was
done, so this is a **static assessment**; it will both over- and under-report. Treat severities as
indicative and re-verify with tooling.

## 1. What is right
* **Radix UI primitives are used for all interactive widgets** (`dialog`, `select`, `popover`,
  `tabs`, `checkbox`, `radio-group`, `switch`, `accordion`, `tooltip`, `toast`) — these provide
  correct roles, keyboard handling and focus trapping by default. This is a genuine strength and
  materially better than a typical hand-rolled component library.
* `Permissions-Policy: camera=(), microphone=(), geolocation=()` (`middleware.ts:13`) is correct and
  restrictive.
* `X-Frame-Options: SAMEORIGIN` (`middleware.ts:8`) prevents clickjacking.
* `lang="en"` is set on `<html>` (`app/layout.tsx:52`).
* `components/ui/label.tsx` is used in 27 files, so visible labels generally exist.
* Radix `Alert` and `Toast` announce politely; the `Toaster` is mounted at the root.

## 2. Findings

### F-A11Y-01 - HIGH: no Content-Security-Policy, and no automated accessibility testing
**Evidence.** `middleware.ts:7-13` sets six headers and **no CSP**;
`X-XSS-Protection: 1; mode=block` (`:11`) is removed from all modern browsers and provides no
protection. No axe, no Lighthouse, no `@axe-core` dependency, no accessibility CI.
**Impact:** no automated detection of regressions; and no defence-in-depth against the
injection-adjacent patterns below.
**Severity:** HIGH | **Confidence:** HIGH
**Recommendation:** a strict nonce-based CSP; automated axe checks in CI on every critical page;
a documented manual test protocol with a screen reader and keyboard-only navigation.

### F-A11Y-02 - HIGH: colour is the sole carrier of status in several places
**Evidence.** status is conveyed by coloured `Badge` components across
`components/attendance/*`, `components/performance/*`, `app/dashboard/*`; for example attendance
status uses `present` / `late` / `absent` / `auto` with no text alternative in several badge
usages. `app/error.tsx:100` uses `bg-gradient-to-r ... bg-clip-text text-transparent` for the
page title.
**Impact:** a player who is colour-blind, or using a screen reader, cannot reliably determine
attendance or performance status. In an HR/contract context this is a fairness and legal issue, not
just a usability one.
**Severity:** HIGH | **Confidence:** MEDIUM
**Recommendation:** every status carries a text label and an icon in addition to colour; never
encode meaning in colour alone; remove gradient text.

### F-A11Y-03 - HIGH: contrast is knowingly unaddressed
**Evidence.** `README.md:166` — *"Fixed visibility issues - Switched to dark theme to resolve text
contrast problems"*; `app/layout.tsx:55` forces `defaultTheme="dark" enableSystem={false}` so
**the light theme is unreachable**. `components/public/public-theme.ts` and
`lib/global-theme.ts` use `text-white/50`, `text-white/70`, `text-white/80` over
`bg-white/10 backdrop-blur-md` surfaces.
**Impact:** the documented remedy was to remove the failing theme rather than fix the palette.
White at 50-70 % opacity on a translucent dark surface is borderline for WCAG AA at body size, and
because the surface is `backdrop-blur` over a video (`public/space-particles.mp4`), the effective
background is not even stable — contrast varies per frame.
**Severity:** HIGH | **Confidence:** MEDIUM-HIGH
**Recommendation:** author and test both themes; use opaque surfaces behind text; enforce contrast
in CI against real token pairings.

### F-A11Y-04 - MEDIUM: autoplaying decorative video with no motion preference handling
**Evidence.** `components/video-background.tsx` (682 B) is used by every public page **and by the
root `error.tsx` and `not-found.tsx`** boundaries; it references
`public/space-particles.mp4` (6.1 MB) with no `prefers-reduced-motion` check and no pause control.
**Impact:** `prefers-reduced-motion` is ignored; a 6.1 MB video autoplays with no user control,
including on an error page; for users with vestibular disorders this is a genuine harm, and it
impedes Core Web Vitals.
**Severity:** MEDIUM | **Confidence:** HIGH
**Recommendation:** honour `prefers-reduced-motion`; provide a poster image; respect
`prefers-reduced-data`; do not autoplay on error boundaries.

### F-A11Y-05 - MEDIUM: focus management is inconsistent outside Radix
**Evidence.** four error/loading layers (`components/error-boundary.tsx`,
`components/loading-error-boundary.tsx`, `app/error.tsx`, `app/global-error.tsx`) plus a custom
`GlobalLoading` overlay (`components/ui/global-loading.tsx`, 5,747 B) that covers the screen. None
of these is a Radix primitive, so none manages focus, and the overlay has no `aria-busy`, no
`role="status"`, and no focus trap.
**Impact:** during a global loading overlay or after an error, keyboard and screen-reader users
can lose their place entirely. A full-screen overlay that is not `aria-modal` and does not trap
focus is actively harmful.
**Severity:** MEDIUM | **Confidence:** HIGH
**Recommendation:** use Radix `Dialog` for any modal overlay; add `role="status"` /
`aria-live="polite"` to loading indicators; move focus to the error heading on a boundary.

### F-A11Y-06 - MEDIUM: the two largest pages are monoliths with no semantic structure guarantees
**Evidence.** `app/dashboard/page.tsx` (60,575 B) and `app/dashboard/finance/page.tsx`
(50,355 B). A repository-wide structural review of heading order, landmark usage and table
semantics in these files was not exhaustive.
**Impact:** heading-order and landmark problems are highly likely in 50-60 KB single files with
long JSX; `components/ui/table.tsx` does provide `<table>` semantics where it is used, but raw
`<table>` markup is used in at least 5 other files.
**Severity:** MEDIUM | **Confidence:** MEDIUM (needs tooling to confirm)
**Recommendation:** decompose; add automated axe checks per route.

### F-A11Y-07 - MEDIUM: destructive actions have no accessible confirmation and one HTML-injection sink
**Evidence.** `components/ui/alert-dialog.tsx` (4,575 B) is **never imported**;
`lib/force-logout.ts:48-65` builds a toast with `toast.innerHTML = ...${reason}...` and appends it
to `document.body`.
**Impact:** (a) destructive operations (the purge endpoint, webhook deletion) have no
accessible confirmation step; (b) `innerHTML` with interpolation is a latent injection sink and
bypasses any future CSP nonce.
**Severity:** MEDIUM | **Confidence:** HIGH

### F-A11Y-08 - LOW: skip-link and focus-visible are not established
**Evidence.** no skip-to-content link; no `focus-visible` ring token in `tailwind.config.ts`
(`theme.extend` contains only `colors`, `borderRadius`, `keyframes`, `animation`); no
`--focus` design token.
**Impact:** keyboard users must tab through the entire navigation on every page load, and focus
may be invisible on custom elements.
**Severity:** LOW | **Confidence:** MEDIUM

### F-A11Y-09 - LOW: `dangerouslySetInnerHTML` without escaping
**Evidence.** `components/ui/chart.tsx:96` (dead code), `app/faq/page.tsx:520` and
`components/seo/OrganizationJsonLd.tsx:18` — the latter two use `JSON.stringify` of internal data.
**Impact:** `JSON.stringify` output is not escaped for a closing `</script>` sequence, so a value
containing `</script>` would break out. The data is hardcoded today, so this is not currently
exploitable — **but it becomes a stored-XSS path the moment organisation names are user input**,
which is the entire premise of a multi-tenant product.
**Severity:** LOW today, **HIGH** in V2 unless fixed | **Confidence:** MEDIUM

### F-A11Y-10 - LOW: `autoSync_tryout_data` name and the pre-login OTP flow are unassessed
**Evidence.** `app/auth/confirm/page.tsx` (13,731 B) implements an OTP confirmation screen;
`input-otp` (the natural control) is an **unused dependency** with a dead
`components/ui/input-otp.tsx`.
**Impact:** the OTP screen is 13.7 KB of hand-rolled input handling with no evidence of
`autocomplete="one-time-code"`, `inputmode`, per-digit labelling or paste support.
**Severity:** LOW | **Confidence:** LOW (not exhaustively reviewed)

## 3. V2 accessibility requirements (target: WCAG 2.2 AA)
1. Automated axe checks on every route in CI, plus a Lighthouse accessibility budget.
2. A skip link, a visible focus ring on every interactive element, and consistent focus order.
3. Status never conveyed by colour alone; every status has a text label and an icon.
4. Both themes authored and contrast-tested against real token pairings; opaque surfaces behind
   text; no gradient text.
5. `prefers-reduced-motion` honoured; no autoplay on error boundaries; no autoplay of large media.
6. All overlays via Radix `Dialog` (focus trap, `aria-modal`, restore focus); loading regions
   marked `aria-busy` / `role="status"`.
7. Every form field programmatically labelled; errors associated via `aria-describedby` and
   announced; nothing relies on placeholder-as-label.
8. Data tables with `<caption>`, `<th scope>`, and correct `aria-sort` where sortable.
9. Escape or safely serialise any JSON injected into a `<script>` block.
10. A documented manual protocol: keyboard-only walkthrough of the 18 critical workflows, plus
    NVDA/VoiceOver on Windows, macOS, iOS and Android.
11. Accessibility acceptance criteria as part of the definition of done, not a final audit.

## 4. Verdict
**REBUILD the accessibility posture.** The use of Radix primitives is a good foundation and should
be kept, but there is no testing, no contrast validation, dark-only by workaround, no motion
preference handling, and no accessible confirmation for destructive actions.
