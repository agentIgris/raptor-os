# 41 - FACILITIES
**Audit.md section:** 48 (SECTION 45 - FACILITIES)

## 1. Status: ABSENT
| Facility capability | Present | Trace |
| --- | --- | --- |
| Office / gaming house / bootcamp / studio | NO | - |
| Room | NO | - |
| Room booking | NO | - |
| Capacity | NO | - |
| Equipment in a room | NO | - |
| Access control | NO | - |
| Facility cost / lease | NO | - |
| Utilities / internet (a real esports cost) | NO | - |
| Health and safety | NO | - |
| Remote / home-worker setup | NO | - |

**No facility concept exists anywhere.** The only spatial hints are `device_info` on the profile
(a player describing their own machine) and `timezone` (a user preference that nothing consumes —
`scripts/00:85`).

## 2. Why it matters for esports specifically
* **Gaming houses and bootcamps** are the dominant cost centre for many professional esports
  organisations after payroll, and they are where most of the compliance risk lives: occupancy
  limits, fire safety, electrical load for many high-draw rigs, insurance, and local licensing.
* **Home / remote setups** are now standard: an organisation must track which players work from
  home, what equipment they have been given, and what connectivity standard they meet.
* **Bootcamps** require room + equipment + catering + travel booking in one place, which is the
  integration point with `39_TRAVEL.md` and `40_ASSETS.md`.
* **Studio and streaming facilities** are required for content production, tying into
  `36_CONTENT.md`.

## 3. Findings

### F-FAC-01 - MEDIUM: no facility or occupancy model
**Evidence.** absence.
**Impact:** room and facility costs cannot be attributed to teams or to cost centres, so the
finance domain (`31_FINANCE.md`) has no way to model the largest non-payroll cost for many
organisations. Bootcamps cannot be planned. Health-and-safety obligations cannot be evidenced.
**Severity:** MEDIUM | **Confidence:** HIGH
**Recommendation:** 64_FUTURE_HR.md and 72_FUTURE_ASSETS.md both depend on this; scope it in
V2 but as a deliberately **lightweight** module - the organisation system of record for rooms,
capacity, cost and bookings, with no attempt at building management.

### F-FAC-02 - MEDIUM: the timezone field exists but is inert
**Evidence.** `users.timezone text DEFAULT 'Asia/Kolkata'` and `users.preferred_language text
DEFAULT 'English'` (`scripts/00:84-85`) are collected but **never read by any code**
(`rg "timezone|preferred_language"` → only the schema and the TS type).
**Impact:** a concrete example of "the data model anticipated internationalisation and the
application never delivered it" (59_INTERNATIONALIZATION.md). Sessions are stored as bare
`date` + `time without time zone`, so a player in another timezone has no correct local view.
**Severity:** MEDIUM | **Confidence:** HIGH

## 3. Verdict
**BUILD NEW, late and lightweight** (see 72_FUTURE_ASSETS.md and 64_FUTURE_HR.md). Do not attempt
facility management (HVAC, maintenance tickets, access control). Scope strictly to: locations,
spaces, capacity, cost allocation, bookings, and the link to assets and travel.
