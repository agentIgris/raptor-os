# 23 — EMAIL
**Audit.md section:** 30 (SECTION 27 — EMAIL SYSTEM AUDIT)

## 1. Finding: there is no email system

**Status: MISSING (not "partially implemented").**

| Capability | State | Evidence |
| --- | --- | --- |
| Transactional email provider | **NONE** | `rg "nodemailer\|resend\|sendgrid\|postmark\|smtp\|SMTP\|emailjs\|ses"` across all `.ts`/`.tsx` → **0 hits** |
| SMTP client dependency | **NONE** | `package.json` has no mail library |
| Email templates | **NONE** | no `emails/`, no `templates/`, no `*.html` mail templates |
| Onboarding email | **NONE** | `/onboarding` is a client flow; nothing is sent |
| Invitation email | **NONE** | no invitation entity exists (`09_AUTHENTICATION.md`) |
| Password-reset email | **Delegated to Supabase's default SMTP** | `app/auth/forgot/page.tsx` calls Supabase; no custom SMTP configured |
| Email verification email | **Delegated to Supabase's default SMTP** | `app/auth/signup/page.tsx` |
| Notification email | **NONE** | |
| Reminder / digest email | **NONE** | `communication_settings` defines `auto_daily_summary` and `auto_weekly_digest` toggles — but these drive **Discord**, not email (`modules/discord-portal/sendToDiscord.ts:244-261`) |
| Report email | **NONE** | PDF export is a client-side download (`lib/pdf-export.ts`) |
| Bounce / complaint handling | **NONE** | |
| Unsubscribe | **NONE** | |
| Email deliverability infrastructure (SPF/DKIM/DMARC) | **NOT APPLICABLE** | no domain sends mail |

## 2. The documentation gap

`.env.example:20-24` documents an SMTP configuration:
```
# Optional: Email service (for notifications)
SMTP_HOST=your_smtp_host
SMTP_PORT=587
SMTP_USER=your_smtp_user
SMTP_PASS=your_smtp_password
```
**None of these four variables is referenced anywhere in the code.** They are aspirational
configuration for a feature that was never built. This is a clear instance of Audit.md Rule 3
failing: documentation implying a capability that does not exist.

## 3. Consequences of the absence

| Consequence | Impact |
| --- | --- |
| **Password reset depends entirely on Supabase's shared SMTP** | Supabase's default SMTP is rate-limited (a few emails/hour on the free tier) and sends from a Supabase-branded address. A password-reset request can be silently dropped under load, and the mail is not brandable. Combined with the **missing `/auth/reset-password` route** (`09_AUTHENTICATION.md` F-AUTH-05), account recovery is unreliable end to end. |
| **No notification channel other than Discord** | A player who is not on Discord receives **no** communication about tryout status, attendance, contract changes, or payment. `24_NOTIFICATIONS.md` documents the full impact. |
| **No invitation mechanism** | Staff and players must be created manually by an admin (`/dashboard/user-management`), and that screen is broken (`app/api/users:140` calls an undefined RPC). So in practice, **new users cannot be onboarded at all**. |
| **No compliance artefacts** | No consent capture, no privacy-notice acknowledgement, no DPA acceptance, no deletion-confirmation notice — all of which an employment/HR feature will require (`92_COMPLIANCE.md`). |
| **No escalation path** | There is no in-product support or "contact us" mechanism that generates a ticket. |

## 4. Verdict

**REPLACE (build new).** Email is not an "improvement" to the legacy system — it is an entirely
absent capability that the target product cannot launch without.

Requirements for V2 (`78_NOTIFICATION_ARCHITECTURE.md`, `82_SAAS_BILLING.md`):
1. A per-tenant transactional provider abstraction (one provider integration, credentials per
   tenant in a secret store, never `NEXT_PUBLIC_*`).
2. Authenticated email for password reset, email verification, magic links and MFA — using
   **Supabase's custom SMTP** so the sending domain is the tenant's and deliverability is under
   our control.
3. Transactional templates rendered per tenant with the tenant's branding
   (`80_WHITE_LABEL.md`): invitation, offer, contract signature request, trial/roster change,
   tryout status change, selection/rejection, attendance exception, payroll statement,
   invoice issued/overdue, sponsor deliverable due, travel itinerary.
4. Every template must be **versioned and stored as a document** with the exact rendered content
   and a hash recorded at send time, so a dispute about what a player was told is answerable.
5. Bounce and complaint webhooks with automatic suppression; an unsubscribe list for
   non-transactional mail; GDPR/CCPA consent records.
6. A dead-letter queue and a per-tenant daily send budget, with alerting.
7. Deliverability: SPF, DKIM, DMARC, a dedicated subdomain, and suppression-list hygiene —
   particularly important because bulk mail to esports audiences is a spam-magnet.
