# 79 - ORGANIZATION CONFIGURATION (requirements only - NOT implemented)
**Audit.md section:** 86 (SECTION 83)

## 1. Starting position
Configuration is a single global key/value table, `admin_config`
(`scripts/00:12-16`), holding `app_version`, `maintenance_mode`, `agreement_version_*`,
`agreement_content_*`, `agreement_enforcement_enabled`, `agreement_dev_override` and
`default_public_webhook_id`. It has **no RLS** (`13_RLS_SECURITY.md` F-RLS-04) and is read by
code with hardcoded key strings. There is no per-organisation configuration at all, because
there is no organisation.

## 2. Principles
1. **Typed, not a key/value bag.** Each setting has a declared type, a default, a validation rule
   and an owner. A typo must fail, not silently create a new key.
2. **Per-tenant, scoped by `org_id`.**
3. **Versioned and audited.** Every change writes an `audit_log` row with before/after.
4. **Defaults are code, not data.** A new tenant gets a documented default set; only overrides are
   stored.
5. **Secrets never live here.** Credentials belong in a secret store; configuration stores only a
   reference.
6. **Changing a setting that affects money, contracts or compliance requires an approval** and
   takes effect at a defined time (some settings must be prospective, not immediate).

## 3. Configuration matrix
### 3.1 Locale and formatting
| Setting | Type | Default | Notes |
| --- | --- | --- | --- |
| `default_locale` | enum | `en` | drives formatting and default templates |
| `supported_locales` | enum[] | `[en]` | drives hreflang and the public site |
| `timezone` (IANA) | string | tenant-set | all display conversion |
| `date_format` / `number_format` | enum | locale-derived | explicit override |
| `week_starts_on` | enum 0-6 | `1` (Mon) | scheduling and calendar maths |

### 3.2 Finance
| Setting | Type | Default | Notes |
| --- | --- | --- | --- |
| `default_currency` | ISO 4217 | `USD` | **required**; every money field defaults to it |
| `fiscal_year_start_month` | 1-12 | `1` | drives periods and budget years |
| `accounting_method` | enum | `accrual` | |
| `tax_profiles[]` | entities | `[]` | per legal entity, per jurisdiction |
| `rounding_policy` | enum | `half_up` | per currency where it differs |
| `approval_thresholds` | map | `{}` | per category; drives `PolicyRule` |
| `po_approval_required_above` | money | `0` | |

### 3.3 People and HR
| Setting | Type | Default | Notes |
| --- | --- | --- | --- |
| `employment_types[]` | enum | `[employee, contractor, player_contract, creator, intern]` | tenant-extensible |
| `departments[]` | entity | `[]` | |
| `cost_centres[]` | entity | `[]` | |
| `work_locations[]` | entity | `[]` | |
| `leave_policies[]` | entity | `[]` | per jurisdiction minimums |
| `review_cycle_months` | int | `12` | plus a `probation_months` |
| `minor_age_threshold` | int | jurisdiction | drives the safeguarding flow |
| `safeguarding_lead_role_id` | role | `null` | **required if minors are engaged** |

### 3.4 Competitive operations
| Setting | Type | Default | Notes |
| --- | --- | --- | --- |
| `games[]` | entity | `[]` | **replaces the hardcoded BGMI assumption** |
| `game_metrics[]` | per game | `[]` | replaces the fixed kills/assists/damage/survival set |
| `divisions[]` / `tiers[]` | entity | `[]` | replaces `teams.tier` free text |
| `default_roster_size` | int | tenant-set | validation on `TeamMembership` |
| `match_formats[]` | entity | `[]` | BO1/BO3/BO5, round rules |
| `attendance_rules` | object | see below | |
| `training_blocks[]` | entity | `[]` | replaces the flat `sessions` model |

### 3.5 Commercial
| Setting | Type | Default | Notes |
| --- | --- | --- | --- |
| `inventory_catalogue[]` | entity | seeded esports defaults | tenant-extensible |
| `crm_stages[]` | ordered list | `[lead, qualified, proposal, negotiation, won, lost]` | tenant-definable |
| `contract_templates[]` | entity | `[]` | **per jurisdiction** |
| `payment_terms_days` | int | `30` | drives invoice due dates |
| `sponsor_reporting_cadence` | enum | `monthly` | |
| `exclusivity_categories[]` | enum | `[]` | conflict checking |

### 3.6 Operations
| Setting | Type | Default | Notes |
| --- | --- | --- | --- |
| `asset_categories[]` | entity | `[]` | |
| `per_diem_rates[]` | by country, effective-dated | `[]` | |
| `travel_approval_thresholds` | money | `{}` | |
| `facility_locations[]` | entity | `[]` | |

### 3.7 Branding and white-label
`brand_name` · `logo_asset_id` · `favicon_asset_id` · `primary_colour` · `accent_colour` ·
`custom_domain` · `email_sender_name` · `email_reply_to` · `public_site_enabled` ·
`public_site_slug` · `social_links{}` · `theme_id` (validated token set, never arbitrary CSS)
(`80_WHITE_LABEL.md`).

### 3.8 Notifications
`default_digest_window` (local time) · `quiet_hours` · `mandatory_event_classes[]` ·
`channel_defaults{}` · `daily_send_budget` · `escalation_policy` (`78_NOTIFICATION_ARCHITECTURE.md`).

### 3.9 Security and compliance
`mfa_required_for_roles[]` · `session_idle_minutes` · `session_absolute_hours` ·
`ip_allowlist[]` · `data_region` (binding; see §4) · `retention_overrides{}` ·
`legal_holds[]` · `dpa_contact` · `breach_contact` · `sso_domains[]` · `scim_enabled` ·
`require_justification_for_export` · `pii_export_allowed`.

### 3.10 Integrations
Per integration: `enabled` · `credentials_ref` (secret store) · `scopes[]` · `rate_budget` ·
`webhook_secret_ref` · `sync_direction` · `degradation_behaviour`
(`76_INTEGRATIONS.md`).

### 3.11 Notifications and platform
`feature_flags{}` (per-tenant opt-in, **default off for AI** - `75_AI_SECURITY.md`) ·
`api_rate_limit_profile` · `maintenance_mode` (replaces the global `admin_config` key) ·
`app_version_visible` · `support_contact` · `status_page_url`.

### 3.12 Attendance rules (migrating the most valuable legacy rules)
```
attendance_rules = {
  practice_windows: [{ label, subtype, start_local, end_local, cutoff_local,
                       recurrence: { weekdays: [] }, team_scope }],
  late_grace_minutes, auto_mark_absent_after_cutoff: bool,
  require_manager_verification: bool, allow_self_marking: bool,
  dispute_window_days, excusal_reasons[],
  holiday_calendar_id, min_attendance_threshold_pct
}
```
This preserves `26_ATTENDANCE.md`'s rules (recurring windows, cutoff auto-absent, holiday
exclusion, performance-implies-attendance, manager verification) while making them **per-tenant
configuration** instead of hardcoded triggers.

## 4. Data residency
`data_region` is **not** a soft setting. It determines the infrastructure (region, storage
bucket, key management, backup location) and is **fixed at organisation creation**. A change
requires a migration, not a toggle. This is a hard constraint from `59_INTERNATIONALIZATION.md` and
must be enforced at provisioning time.

## 5. Migration from the legacy system
* `admin_config` -> `OrgSettings` rows for a single importing organisation, **with every value
  flagged `provenance_unverified`** because the table was world-writable.
* `communication_settings` -> the seed for `NotificationRule` defaults.
* `tier_defaults` -> `inventory_catalogue` seed entries (or a per-team price list), **not**
  `divisions`/`tiers`, which are a different concept (`30_TEAMS.md` F-TEAM-05).
* `practice_session_config` -> `attendance_rules.practice_windows`.
* **The hardcoded BGMI constants** (`BGMI_TIERS`, `CONTROL_LAYOUTS`,
  `DEFAULT_SENSITIVITY_SETTINGS` in `lib/profile-utils.ts:7-16, 21-27, 336-368`) become seeded
  `game_metrics` / `game_settings` reference data, and stop being schema constraints.

## 6. Verdict / status
**REQUIREMENTS ONLY.** This is a substantial surface, and it is the mechanism that converts a
single-tenant product into a product that can serve organisations with genuinely different
processes - which is the commercial premise of the whole V2.
