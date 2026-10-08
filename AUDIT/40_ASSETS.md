# 40 - ASSETS
**Audit.md section:** 47 (SECTION 44 - EQUIPMENT)

## 1. Status: ABSENT as an asset domain. Only player device self-reports exist.
| Asset capability | Present | Trace |
| --- | --- | --- |
| Asset register | NO | - |
| Asset type / category | NO | - |
| Serial number / IMEI / asset tag | NO | - |
| Assignment to a person | NO | - |
| Assignment to a team | NO | - |
| Condition | NO | - |
| Purchase date / cost / warranty | NO | - |
| Maintenance / repair | NO | - |
| Check-in / check-out | NO | - |
| Loss / damage report | NO | - |
| Return / offboarding check | NO | - |
| Depreciation | NO | - |
| Inventory audit | NO | - |

**The only related data** is *self-reported device telemetry* on the user profile:
`device_info`, `device_model`, `ram`, `fps`, `storage`, `gyroscope_enabled`
(`scripts/00:51-57`; `lib/profile-utils.ts:182`). This is the player telling the organisation
what hardware they own, for sensitivity-configuration purposes - it is **not** an asset register
(there is no serial number, no purchase record, no owner, no liability, no return).

## 2. Findings

### F-AST-01 - HIGH: no asset register, in an industry where the hardware IS the business
**Evidence.** exhaustive absence.
**Impact:** esports organisations routinely issue and own high-value hardware - gaming rigs,
monitors, peripherals, headsets, capture gear, phones, tablets, network equipment, and
team jerseys/kits. Without a register there is no way to know what the organisation owns, who has
it, what it is worth, what is warranty-covered, or what to recover when someone leaves. Insurance,
audits and sponsor asset-disclosure obligations all depend on it.
**Severity:** HIGH | **Confidence:** HIGH

### F-AST-02 - HIGH: no link between assets and employment offboarding
**Evidence.** no offboarding concept (34_HR.md).
**Impact:** when a player or creator leaves, there is no checklist to recover equipment, no record
of what was returned, and no way to value the loss. In many jurisdictions an employer cannot
deduct the value of unreturned property from final pay without a documented process.
**Severity:** HIGH | **Confidence:** HIGH

### F-AST-03 - MEDIUM: device data is personal data with no purpose limitation
**Evidence.** users.device_model / ram / fps / storage / gyroscope_enabled, plus
`hud_layout_code` and `sensitivity_settings` (scripts/00:51-57, 73-76).
**Impact:** precise device and input fingerprints are collected with no consent statement, no
purpose limitation, and no retention policy, from a population that includes minors. This is a
privacy exposure disproportionate to the operational need (the operational need is a recommended
sensitivity profile, not a hardware inventory).
**Severity:** MEDIUM | **Confidence:** HIGH
**Recommendation:** separate "recommended settings" (organisational advice) from "device
fingerprint" (personal data), and gate the latter behind explicit consent.

### F-AST-04 - MEDIUM: the media bucket is an unowned asset store
**Evidence.** the `media` bucket (20_STORAGE.md) - files with no owner, no metadata, no
retention, publicly readable, deletable by anyone.
**Impact:** the closest thing the organisation has to an asset store is unprotected and
unmanaged.
**Severity:** MEDIUM | **Confidence:** HIGH

## 3. Verdict
**BUILD NEW** (72_FUTURE_ASSETS.md). Scope: an asset register with type, serial/IMEI, purchase
and warranty, condition, location, and a chain of assignment; a check-out/check-in workflow;
maintenance and incident reporting; an offboarding recovery checklist; optional depreciation for
finance; and a periodic inventory audit with variance reporting. Jerseys and kits should be
modelled as consumable assets with a size inventory, because they are both an asset and a
sponsor-branded item.
