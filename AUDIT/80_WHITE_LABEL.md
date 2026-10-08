# 80 - WHITE LABEL (requirements only - NOT implemented)
**Audit.md section:** 87 (SECTION 84)

## 1. Starting position
**Architecturally impossible today.** `tailwind.config.ts` defines tokens once as CSS custom
properties in `app/globals.css` under `:root`/`.dark`; there is no mechanism to scope a token set
to an organisation (`AUDIT_DESIGN_SYSTEM.md` F-DS-07). Branding is hardcoded in `app/layout.tsx`
(title, description, OpenGraph, icons), `lib/global-theme.ts` (class strings),
`components/public/public-theme.ts`, and the public site's copy.

## 2. What must be themeable
| Surface | Requirement | Risk |
| --- | --- | --- |
| **Logo and favicon** | per-tenant `logo_asset_id` + `favicon_asset_id`, with a size/variant contract | low |
| **Colours** | a **validated token subset** - the tenant maps a few semantic roles (`primary`, `accent`, `surface`, `text`, `danger`, `success`) onto a fixed token set; the tenant may **not** inject arbitrary CSS | **high** if arbitrary CSS is allowed: it would defeat CSP, enable clickjacking and cross-tenant style injection |
| **Typography** | optionally a tenant font from an allowlist of self-hosted families; never an arbitrary remote font URL | medium |
| **Email** | per-tenant sending domain, DKIM, reply-to, and a branded template set (`23_EMAIL.md`) | medium |
| **Public pages** | organisation name, description, logo, colours, navigation, sections enabled, and SEO metadata | low |
| **In-app chrome** | logo, name, and the token subset; **not** the information architecture | low |
| **Login and invitation screens** | logo and colours only | low |
| **Generated documents** | letterhead: logo, entity name, address, registration number | medium - a document's letterhead is a legal artefact |
| **Custom domain** | see §4 | high |
| **Email addresses** | per-tenant sending subdomain | medium |

## 3. What must NOT be themeable
The information architecture, the domain model, the navigation structure, the role names, the
workflow definitions, the report templates' structure, and the notification content structure.
Theming must never be able to change what the product *does*.

## 4. Custom domains
Requirements:
* Per-tenant domain with a verified DNS record (TXT/CNAME) before activation.
* TLS certificate issuance and renewal, with monitoring and an expiry alert.
* DNS-based tenant resolution at the edge: `org-slug.platform.com` for the public site, and a
  **path-based** form (`/o/{org-slug}/…`) for the authenticated app, or a verified custom domain
  mapped to one org.
* **Strict isolation:** a hostname resolves to exactly one organisation, derived from a
  **server-side** lookup - never from a client-supplied parameter.
* A default platform domain always works, so a tenant never needs a custom domain.
* Cache keys, rate limits, CORS and CSP must all include the resolved organisation.
* Email deliverability: either a subdomain per tenant (`{org}.mail.platform.com`) or a verified
  custom sending domain.

## 5. Public theming
`81_PUBLIC_WEBSITE.md` covers this. The key constraint: the public site is a **tenant-scoped
projection** of the same data, with a per-tenant section configuration, and it must never expose
anything the tenant has not explicitly published.

## 6. Implementation approach
1. **Tokens as a validated, closed set.** Define the semantic roles; the tenant supplies values;
  the platform validates them (contrast ratio, format) and emits a scoped CSS custom property
  block, e.g. `[data-org="{orgId}"] { --primary: …; }`. **No arbitrary CSS, ever.**
2. **Contrast is validated at configuration time**, in both themes, with a hard failure on a
   failing pair - because the legacy system already had to disable its light theme to escape a
   contrast problem (`AUDIT_DESIGN_SYSTEM.md` F-DS-05).
3. **Assets, not URLs.** Logos and favicons are `Asset` rows, served from private storage through
   short-lived signed URLs or a CDN with tenant-prefixed keys.
4. **A published token contract** so a tenant (or an agency) can design a valid theme without
   developer help - and a documented fallback theme.
5. **Every theme change is versioned and audited**, with a preview before activation.

## 7. Migration from the legacy system
There is one organisation. Its brand is hardcoded in `app/layout.tsx` and the public site; the
tokens in `app/globals.css` become the platform default theme. `lib/global-theme.ts` and
`components/public/public-theme.ts` are **deleted** in favour of tokens
(`06_UI_COMPONENTS.md` §3).

## 8. Verdict / status
**REQUIREMENTS ONLY.** White label is what converts a product into a platform that an agency or a
sponsor-branded property can resell, and it is architecturally impossible in the legacy system -
which is itself a finding: if white label is a commercial requirement, it must be designed into
the token system before the V2 frontend is built, not added later.
