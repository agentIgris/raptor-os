# Documentation

Everything about Raptor OS, in the order you are likely to need it.

---

## Start here

| If you want to… | Read |
| --- | --- |
| run it | [SETUP.md](./SETUP.md) |
| run it as an AI agent | [AI-AGENT-GUIDE.md](./AI-AGENT-GUIDE.md) and [`../AGENTS.md`](../AGENTS.md) |
| show it to someone | [DEMO.md](./DEMO.md) |
| understand the system | [ARCHITECTURE.md](./ARCHITECTURE.md) |
| understand the rules | [SECURITY.md](./SECURITY.md) |
| understand the data | [DATA-MODEL.md](./DATA-MODEL.md) |
| change it | [DEVELOPMENT.md](./DEVELOPMENT.md) |
| trust the tests | [TESTING.md](./TESTING.md) |
| deploy it | [OPERATIONS.md](./OPERATIONS.md) |

---

## The full list

### Getting started
- **[SETUP.md](./SETUP.md)** — prerequisites, the one-command bootstrap, the
  step-by-step path, what you get, troubleshooting.
- **[DEMO.md](./DEMO.md)** — the demo runbook: the tour, the accounts, the
  proof script, the one security deviation stated plainly.
- **[AI-AGENT-GUIDE.md](./AI-AGENT-GUIDE.md)** — the agent playbook: the
  bootstrap, the invariants, the change workflow, the verification ladder, the
  traps, and how to report honestly.
- **[../AGENTS.md](../AGENTS.md)** — the short rulebook, always in force.

### The system
- **[ARCHITECTURE.md](./ARCHITECTURE.md)** — the package map, the request
  lifecycle, identity and tenancy, the content plane, the assistant, the
  deployment topology, and the constraints that survive refactors.
- **[DATA-MODEL.md](./DATA-MODEL.md)** — the three data planes, the identity
  boundary, the ERD, all 91 domain tables by area, and the tenancy
  mechanics.
- **[adr/](./adr/README.md)** — the decision records. Each one states a
  context, a decision and its consequences, and is never rewritten after the
  fact.

### Doing the work
- **[DEVELOPMENT.md](./DEVELOPMENT.md)** — commands, the shape of a change,
  where things live, conventions, the ADR process, git conventions.
- **[TESTING.md](./TESTING.md)** — the standard (a test must fail when its
  control is broken), the suites, what each one proves, how to write a test,
  the gates, and how to handle a failure.
- **[SECURITY.md](./SECURITY.md)** — the threat model, identity, authorisation
  in three layers, throttling, the MFA policy and the demo deviations, the
  secrets, and the audit trail.
- **[OPERATIONS.md](./OPERATIONS.md)** — environments, the environment
  variables, the migration discipline, deployment, health, backups, and
  incident playbooks.

### Product and planning
- **[product/PRESENTATION-BRIEF.md](./product/PRESENTATION-BRIEF.md)** — the
  pitch: the problem, the solution, the market.
- **[product/raptor-esports-frontend.md](./product/raptor-esports-frontend.md)**
  — the build plan for the public site, the workspace and the CMS.
- **[product/BRAND-ASSETS-REQUIRED.md](./product/BRAND-ASSETS-REQUIRED.md)**
  — the brand asset requirements, with the exact filenames and sizes.

### The legacy system
- **[../AUDIT/00_AUDIT_README.md](../AUDIT/00_AUDIT_README.md)** — the index of
  the audit of the system this repository replaces: 96 documents covering
  architecture, auth, authorisation, data, RLS, APIs, domains and
  deployment.
- **[../AUDIT/MASTER_AUDIT_REPORT.md](../AUDIT/MASTER_AUDIT_REPORT.md)** — the
  summary, and the findings this rebuild answers.

---

## Conventions in this documentation

- **Claims about the system are measured.** Where a document says something
  works, it says how that was observed.
- **The past tense is used for the legacy system and the present tense for
  this one.** The audit describes what was; these documents describe what is.
- **A deviation is written down where it applies.** The demo build's
  password-only sign-in is stated in the security model, in the operations
  guide, in the demo runbook and in the README — never only in a commit
  message.
- **Nothing here is a secret.** No credential appears in any document. The
  local passwords are development constants for a loopback database, and they
  are in `.env.example` and the bootstrap script, not in prose.

---

## Keeping the documentation true

A document that describes behaviour the code no longer has is a defect, and
this repository treats it as one. When you change behaviour:

1. update the document in the same change, and
2. say in the commit message which document you updated.

The documents most likely to go stale are the ones that name a specific
mechanism: the MFA flow, the rate limiter's arithmetic, the session
rotation, the RLS policies. They are the ones worth re-reading when you touch
the area they describe.
