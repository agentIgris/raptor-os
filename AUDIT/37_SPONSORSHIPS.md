# 37 - SPONSORSHIPS
**Audit.md section:** 44 (SECTION 41 - SPONSORSHIP DOMAIN)

## 1. Status: ABSENT
| Sponsorship capability | Present | Nearest legacy artefact |
| --- | --- | --- |
| Sponsor / brand entity | NO | - |
| Contact | NO | - |
| Deal / contract | NO | - |
| Campaign | NO | - |
| Deliverable / obligation | NO | - |
| Inventory (jersey, slot, post, mention) | NO | - |
| Approval workflow | NO | - |
| Proof of delivery | NO | communication_logs records Discord sends only, and is publicly forgeable |
| Publication record | NO | - |
| Performance reporting | NO | - |
| Invoicing / receivables | NO | - |
| Product / merchandise linkage | NO | - |
| Affiliate / commission tracking | NO | - |
| Media kit | NO | - |
| Renewal / pipeline | NO | - |

The word "sponsor" appears nowhere in the SQL. The public site has a "Brand / Collaboration"
contact mode (`app/contact/page.tsx`), which relays an enquiry to a Discord webhook
(`app/api/public/submit/contact`) and stores an attachment in a world-readable bucket. That is
the entirety of the commercial pipeline.

## 2. Findings

### F-SPN-01 - CRITICAL: sponsorship management does not exist
**Evidence.** exhaustive absence.
**Impact:** sponsorship is typically the largest revenue line for an esports organisation after
prize money. Without sponsors, campaigns, deliverables, proof and invoicing, the platform cannot
support the organisation's core commercial function, cannot evidence delivery to a sponsor, and
cannot recognise or defer sponsor revenue.
**Severity:** CRITICAL | **Confidence:** HIGH

### F-SPN-02 - HIGH: brand enquiries are handled by an unauthenticated Discord relay
**Evidence.** app/contact/page.tsx (mode "Brand / Collaboration") posts to
/api/public/submit/contact, which has NO authentication, NO rate limit, and posts attacker-
supplied content to the organisation's Discord channel using a credential held in a
NEXT_PUBLIC_ variable (19_SECRETS.md F-SEC-01). Attachments go into a bucket that is publicly
listable, downloadable and deletable (15_API_SECURITY.md F-API-03).
**Impact:** a competitor can flood or spoof the brand pipeline; genuine prospect documents
(rate cards, NDAs, registration certificates) are publicly exposed; and there is no record of
who enquired.
**Severity:** HIGH | **Confidence:** HIGH
**Recommendation:** a real CRM intake with an authenticated staff inbox
(69_FUTURE_PARTNERSHIPS.md).

### F-SPN-03 - HIGH: no receivable, so no sponsor revenue is recorded
**Evidence.** no invoice entity at all (31_FINANCE.md).
**Impact:** money owed by a sponsor is invisible; there is no ageing, no reconciliation, and no
basis for the financial statements an organisation's board requires.
**Severity:** HIGH | **Confidence:** HIGH

## 3. Verdict
**BUILD NEW.** Requirements are specified in 69_FUTURE_PARTNERSHIPS.md (CRM pipeline) and
70_FUTURE_SPONSORSHIP.md (inventory, obligations, proof, performance). The critical insight for
V2: the commercially valuable asset is not "a sponsor record" but **provable fulfilment** - a
quantified inventory of placements, a contractual obligation attached to each, an owner, a
deadline, an approval, and evidence of publication with performance. That is what a sponsor pays
for and what an auditor asks for.
