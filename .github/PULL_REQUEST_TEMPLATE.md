## What this changes

<!-- One or two sentences. What is different after this pull request? -->

## Why

<!--
The reason, not the restatement of the diff. What forced the change, what
was measured, what was tried and rejected. If a claim is being made about
behaviour, say how it was observed.
-->

## How it was verified

<!--
Paste the evidence. The gate, the live check, the before/after measurement.

    pnpm verify
    ...

    node scripts/verify-assistant-roles.mjs
    ...

A reviewer should be able to reproduce this from the description alone.
-->

- [ ] `pnpm verify` is green
- [ ] The live check was run, if the change touches the running stack
- [ ] New or changed behaviour has a test that **fails when the behaviour is broken**
- [ ] Comments describing the changed behaviour were updated
- [ ] A document describing the changed behaviour was updated (name it: ______)
- [ ] No secret, token, password or connection string appears anywhere in the diff

## Reviewer, please check

<!--
What you want a reviewer to look at hardest. The subtle part, the part that
looks wrong but is deliberate, the part where a second opinion matters.
-->

## Risk and rollback

<!--
What breaks if this is wrong, and how to undo it. "Nothing" is an acceptable
answer; so is a one-line revert.
-->
