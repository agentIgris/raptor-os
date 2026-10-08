# 63 - INTERNATIONALIZATION
**Audit.md section:** 66 (SECTION 63 - INTERNATIONALIZATION)

## 1. Current state: effectively none, with two inert exceptions
| Dimension | Support | Evidence |
| --- | --- | --- |
| **Languages / UI translation** | **NONE** | no i18n library (`next-intl`, `react-i18next`, `react-intl` are all absent); no locale routing (`app/[locale]/` does not exist; `app/` has no `[locale]` segment); no message catalogue; no `locale` in `next.config.mjs`; every string is hardcoded English in JSX |
| **Pluralisation / RTL** | **NONE** | no `dir` handling; `<html lang="en">` is hardcoded (`app/layout.tsx:52`); no RTL logical properties in the Tailwind config |
| **Date & number formats** | **Implicit en-US only** | native `toLocaleDateString()` / `toLocaleString()` with **no locale argument** in ~15 places, e.g. `app/api/discord/tryout/apply:171`, `announce:166`, `evaluate:205`, `status`, `app/error.tsx:109` — these use the **runtime's** locale, so output differs per device |
| **Locale-aware `<html lang>`** | **NONE** | hardcoded `en` |
| **Currency** | **NONE, and INR-hardcoded** | all money columns are `integer` with **no `currency` column anywhere**; the rupee symbol is hardcoded in the UI (`README.md:168` "Changed dollar symbols to rupee symbols"); the finance dashboard icon is `IndianRupee` (`lib/dashboard-permissions.ts:73`) |
| **Time zones** | **Column exists, never used** | `users.timezone text DEFAULT 'Asia/Kolkata'` (`scripts/00:85`) and `users.preferred_language text DEFAULT 'English'` (`:84`) — **never read by any code** (`rg "timezone\|preferred_language"` → only the schema and the TS type) |
| **Time storage** | **Not zone-aware** | `sessions.date date`, `sessions.start_time time WITHOUT TIME ZONE`, `attendances.date date`, `attendances.session_time text` (`scripts/00:229, 243, 247`) — a session at 19:00 in Berlin and 19:00 in São Paulo are the same stored value |
| **Taxation** | **NONE** | no tax rate, jurisdiction, or withholding anywhere |
| **Regions / data residency** | **NONE** | single Supabase project; no region concept |
| **Regulatory variants** | **NONE** | — |
| **Number/currency formatting library** | **NONE** | no `Intl` wrapper; formatting is ad hoc |
| **Translated seed content** | **NONE** | the seeded tryout descriptions and requirements in `database/SUPABASE_TRYOUTS_SETUP_FIXED.sql:342-400` are English only |

## 2. Findings

### F-I18N-01 - HIGH: no localisation framework at all
**Evidence.** absence of any i18n dependency or locale routing; every user-facing string is a
hardcoded English literal in JSX (e.g. `app/error.tsx:51` "Something went wrong in the Raptor
Hub", `app/not-found.tsx:21` "Page not found"). Mojibake in several of these strings
(`app/layout.tsx:22`, `app/error.tsx:102-104`) shows the copy passed through an unsafe toolchain.
**Impact:** V2 cannot ship to a non-English market without rewriting every component. For a
multi-tenant SaaS, a customer cannot run their organisation in their own language. Retrofitting
i18n after the fact is one of the most expensive changes in a codebase.
**Severity:** HIGH | **Confidence:** HIGH
**Recommendation:** decide the i18n strategy **before** building V2 UI. Adopt message catalogues
from day one, locale-prefixed routes, and a `<html lang>` derived from the route. Do not
retrofit.

### F-I18N-02 - HIGH: no multi-currency, with one currency hardcoded
**Evidence.** no `currency` column on any money column (`scripts/00:176-207`);
`integer` money; the rupee symbol hardcoded in the UI; the finance module icon is `IndianRupee`
(`lib/dashboard-permissions.ts:73`).
**Impact:** a SaaS charging organisations in different currencies has no way to record which
currency a transaction is in, no FX rate at transaction date, and no minor-unit support
(`integer` cannot represent 0.01). This is a **hard blocker for multi-country selling**, not a
formality.
**Severity:** HIGH | **Confidence:** HIGH
**Recommendation:** `numeric(18,4)` money plus an ISO 4217 `currency` column per monetary
document; FX rate captured at transaction date; per-tenant default currency with per-document
override; per-tenant formatting via `Intl.NumberFormat`.

### F-I18N-03 - HIGH: time zones are not modelled, and a "timezone preference" column is dead
**Evidence.** `users.timezone` and `users.preferred_language` exist (`scripts/00:84-85`) and are
**never read**; all times are stored as naive `date` / `time without time zone` /
`session_time text`.
**Impact:** a training session at 19:00 local time is stored as `19:00` with no zone, so it
displays as 19:00 to every viewer regardless of location. Attendance cutoffs, tournament
schedules and travel itineraries are all wrong for any organisation not in a single time zone.
**Severity:** HIGH | **Confidence:** HIGH
**Recommendation:** store timestamps in UTC (`timestamptz`); store the tenant's IANA zone as
configuration; convert at the edges; treat a recurring local-time schedule as
(local wall-clock time + zone) and resolve it per occurrence.

### F-I18N-04 - MEDIUM: date and number formatting follows the device, not the tenant or the user
**Evidence.** bare `toLocaleDateString()` / `toLocaleString()` with no locale argument in at least
15 call sites, e.g. `app/api/discord/tryout/apply:171`
`new Date().toLocaleDateString()`, `announce:166`, `evaluate:205`, `app/error.tsx:109`.
**Impact:** the same server-side string differs per device, so a Discord embed rendered from
different machines is inconsistent; and the format ignores both the tenant's and the
recipient's preference.
**Severity:** MEDIUM | **Confidence:** HIGH
**Recommendation:** format server-side with an explicit locale and time zone, taken from the
tenant configuration and the recipient's preference; pass a pre-rendered string to the
integration.

### F-I18N-05 - MEDIUM: no tax, no jurisdiction, no regional compliance model
**Evidence.** absence. `prize_pools`, `winnings`, `slot_expenses` have no tax fields; there is no
jurisdiction, entity, or withholding concept.
**Impact:** prize money and sponsorship income carry withholding obligations that vary by
jurisdiction; contractor payments carry different obligations from employee payments. The
platform cannot record what must be withheld or reported, which is a fundamental requirement for
`65_FUTURE_PAYROLL.md` and `66_FUTURE_FINANCE.md`.
**Severity:** MEDIUM | **Confidence:** HIGH

### F-I18N-06 - MEDIUM: no data-residency concept
**Evidence.** a single Supabase project; no region field on any entity.
**Impact:** EU customers with data-residency requirements, and Indian customers subject to
localisation rules, cannot be served from a single region. This constrains which customers V2 can
sell to.
**Severity:** MEDIUM | **Confidence:** HIGH

### F-I18N-07 - LOW: the public site is single-brand and single-language by construction
**Evidence.** `components/seo/OrganizationJsonLd.tsx`, `app/sitemap.xml/route.ts:16` and
`app/faq/page.tsx:432` all hardcode `https://raptor-esports.example` fallbacks and a single
organisation; no `hreflang` alternates; no locale-specific metadata.
**Impact:** no SEO or hreflang support for any additional market.
**Severity:** LOW | **Confidence:** HIGH

## 3. V2 internationalisation requirements
1. **Decide before building.** i18n retrofitted onto a finished UI is a multi-month rewrite.
2. **UI:** message catalogues, locale-prefixed routes, `lang` and `dir` derived from the route,
   RTL support from day one, per-tenant default locale with per-user override, and pluralisation
   and number/date formatting via `Intl`.
3. **Data:** every monetary amount as `numeric(18,4)` + ISO 4217 `currency`; every timestamp in
   UTC (`timestamptz`); recurring schedules stored as local wall-clock time plus an IANA zone;
   a per-tenant fiscal calendar (`79_ORG_CONFIGURATION.md`).
4. **Compliance:** jurisdiction per legal entity; tax and withholding recorded on payroll and
   prize transactions; data-residency region per tenant, with a routing decision made at signup
   and enforced at the infrastructure layer.
5. **Content:** the public site and any tenant-authored content must be translatable; agreement
   and contract documents are **jurisdiction-specific and must NOT be machine-translated** - each
   locale requires a separately approved document version (`73_FUTURE_DOCUMENTS.md`).
6. **Testing:** pseudo-localisation, right-to-left rendering tests, and locale-specific visual
   regression in CI.
7. **Fallback discipline:** a missing translation must fail a test, not silently fall back to
   English in production.

## 4. Verdict
**BUILD NEW, as a pre-condition rather than a later phase.** Multi-currency and time zones are
hard blockers for international sale; UI localisation must be decided before the V2 frontend is
built.
