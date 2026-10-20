# Security Policy

## Reporting a vulnerability

**Please do not open a public issue for a security vulnerability.**

Report it privately through GitHub's security advisory form
(**Security → Report a vulnerability** on this repository), or by contacting
the maintainer directly. Include:

- what the vulnerability is, and which component is affected;
- how to reproduce it, ideally with a request or a script;
- what an attacker gains;
- any suggested fix, if you have one.

You will get an acknowledgement within a few days and an assessment of the
report shortly after. Fixes for confirmed issues ship in the next release, and
the advisory is published after the fix is available.

## Supported versions

| Version | Supported |
| --- | --- |
| `main` | yes |
| older branches | no — upgrade to `main` |

## The security model

The threat model, the identity and authorisation design, the secrets rules and
the audit trail are documented in
**[docs/SECURITY.md](./docs/SECURITY.md)**. Read it before reporting
something: most reports are answered by a line in that document.

## A note on the demo build

The build this repository currently ships does **not** issue a second factor:
the `twoFactor` plugin is not installed, so a password is the whole sign-in
for every role, including owner and the CMS admin.

A privileged account in that build is therefore protected by its password
alone. This is a deliberate, documented deviation for a local demo — the MFA
policy, the database trigger, both session gates, the account lockout, CSRF
and origin checks, RLS, the audit log and the role scoping are all still in
force — and it is **not** a configuration to use against real data.

The full statement, and the three steps to re-enable the challenge, are in
**[docs/SECURITY.md → Demo deviations](./docs/SECURITY.md#demo-deviations)**.

## What we consider a vulnerability

- a cross-tenant read or write of any data;
- a session, role or enrolment flag that a client can set for itself;
- an authentication bypass, or a way to obtain a session without the
  password;
- a secret exposed in the repository, a log, an error message or a response;
- a privilege escalation between roles;
- a disabled control — a rate limit, a lockout, a CSRF or origin check, an
  RLS policy — that is described in the documentation as being in force.
