# 36 - CONTENT
**Audit.md section:** 43 (SECTION 40 - CONTENT DOMAIN)

## 1. Status: ABSENT as a domain
| Content capability | Present | Nearest legacy artefact |
| --- | --- | --- |
| Content idea / pitch | NO | - |
| Content item / asset record | NO | media bucket with a listing screen |
| Production pipeline (idea to published) | NO | - |
| Script / brief / shot list | NO | - |
| Assignment to a creator or editor | NO | - |
| Review / approval workflow | NO | - |
| Content calendar / schedule | NO | sessions are TRAINING sessions, not publications |
| Publishing | NO | - |
| Platform links | NO | - |
| Content performance analytics | NO | - |
| Sponsor integration inside content | NO | - |
| Rights / usage / licensing | NO | - |
| Archive | NO | - |

**The only adjacent capability** is `app/dashboard/media/page.tsx` (6,110 B), a thin listing of
objects in the public `media` bucket with an "Open" button that calls
`window.open(m.url, '_blank')` (`:144`). It has no metadata, no owner, no workflow, and it is
built on the two unauthenticated service-role endpoints (`20_STORAGE.md`).

## 2. Findings

### F-CNT-01 - HIGH: content is unmanaged
**Evidence.** the media screen and the media bucket are the whole of it. No table records what a
file is, who made it, what it is for, whether it is approved, where it is published, or how it
performed.
**Impact:** an organisation producing daily video content across multiple platforms has no
system for it at all. Content is also the primary vehicle for sponsor deliverables
(`38_COMMERCIAL_INVENTORY.md`), so this blocks the commercial domain too.
**Severity:** HIGH | **Confidence:** HIGH

### F-CNT-02 - MEDIUM: the media screen depends on unauthenticated, world-writable storage
**Evidence.** app/dashboard/media/page.tsx calls /api/media/upload and /api/media/delete, which
have NO authentication and use the service-role key (15_API_SECURITY.md F-API-01, F-API-02). Any
authenticated role can reach the page (DASHBOARD_MODULES allows admin, manager, coach, analyst),
and in fact anyone at all can call the endpoints directly.
**Impact:** the organisation's media library is not protected. Files can be deleted by anyone on
the internet.
**Severity:** MEDIUM (functional) / CRITICAL (security, cross-referenced) | **Confidence:** HIGH

## 3. Verdict
**BUILD NEW.** Requirements are specified in 68_FUTURE_CONTENT.md. Key points: a ContentItem
entity with a type, owner, status pipeline (idea, briefed, producing, review, approved,
scheduled, published, archived); an Asset library bound to ContentItems; an approval workflow
with named approvers; a publishing calendar with per-platform records; performance metrics
snapshotted with a fetch timestamp; and a rights/licence record. Content items must be linkable
to sponsor Deliverables so fulfilment is provable.
