# 43 - TASKS
**Audit.md section:** 50 (SECTION 47 - TASKS)

## 1. Status: ABSENT
There is no task entity, no task table, no task API, no task UI. Verified: no `tasks`,
`todo`, `action_item` or `checklist` table in any of the 43 SQL files; no `app/api/tasks`;
no task component.

**The nearest things, and why none of them is a task system:**
| Artefact | What it is | Why it is not a task system |
| --- | --- | --- |
| `admin_config` | key/value configuration | no owner, no due date, no status, no completion |
| `module_permissions` | role x module x can_access | a static matrix, never read by the app |
| `communication_settings` | 9 boolean automation toggles | a switch, not a unit of work |
| `sessions` | scheduled training events | a calendar entry, not an assignment |
| `toast` notifications | transient UI feedback | ephemeral, not persisted |
| `tryout_selections.notes` | free text | unstructured |

## 2. Can tasks be connected to the domains Audit.md lists?
| Domain | Task linkage possible today? | Reason |
| --- | --- | --- |
| Contracts | **No** | no task entity; `user_agreements` has no owner or due date |
| Campaigns | **No** | no campaign entity at all |
| Matches | **No** | no match entity; only `slots` and `performances` |
| Content | **No** | no content entity |
| HR | **No** | no onboarding checklist, no probation review task, no offboarding checklist |
| Finance | **No** | no approval workflow; the only "approval" is the purge endpoint, which has no task |
| Travel | **No** | no travel entity |
| Operations | **No** | — |

**0 of 8.**

## 3. Findings

### F-TSK-01 - HIGH: no task or work-item concept
**Evidence.** exhaustive absence.
**Impact:** every workflow in the product is a single-user, single-screen action. There is no
assignment, no due date, no dependency, no delegation, no recurring item, no completion
evidence. For a multi-person organisation this is the coordination substrate, and its absence is a
primary reason an operations team would leave the product. It also means approval workflows
(contracts, expenses, sponsor deliverables, travel) have nowhere to live.
**Severity:** HIGH | **Confidence:** HIGH

### F-TSK-02 - MEDIUM: the closest thing to a workflow is a database trigger, which is invisible and unauditable
**Evidence.** `automation-scripts/05-triggers-setup.sql` and the 9 triggers declared in
`automation-scripts/README.md`; e.g. `create_slot_expense()` inserts a financial row with no
actor and no record of the actor.
**Impact:** automation is implemented as invisible database side effects rather than as
observable, auditable workflow steps. When something goes wrong there is no "what happened"
record and nobody was notified.
**Severity:** MEDIUM | **Confidence:** HIGH
**Recommendation:** model automation as first-class workflow definitions with an execution log
(`44_WORKFLOWS.md`).

## 4. Verdict
**BUILD NEW.** This is a cross-cutting capability, best implemented as a first-class domain in
`90_DOMAIN_ARCHITECTURE.md` (Workflow) with:
* `work_items` (type, title, body, status, priority, due_at, owner, parent, entity_type,
  entity_id) — polymorphic but with a validated entity registry;
* `work_item_assignments` (many assignees, roles: owner / reviewer / approver);
* checklists and subtasks;
* recurring items and templates;
* an approval state machine per item type, writing to the audit log;
* reminders and escalations via `78_NOTIFICATION_ARCHITECTURE.md`;
* Slack-style mentions replaced with in-app + email + Discord channel notifications.
Every other domain in V2 should be able to create and track work items against its own records.
