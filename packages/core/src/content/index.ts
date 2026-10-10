/**
 * Content: the editorial pipeline, review and approval, and scheduling.
 *
 * Four decisions make the phase's content half honest rather than decorative:
 *
 * 1. **The lifecycle is a table, and irreversibility is derived from it.**
 *    `draft → review → approved → scheduled → published → archived`, with a pure
 *    `canTransition`. Publication is irreversible, because the audience has seen
 *    it; archiving is irreversible from either end. Both are derived by
 *    *reachability* and pinned by name in the tests — see `./lifecycle.ts` for why
 *    a direct reverse edge would give the wrong answer here.
 * 2. **Approval is refused to the item's own creator.** Separation of duties, the
 *    same control `tryout/state-machine.ts` applies to `evaluated → selected`. The
 *    check is on person ids, not names or roles, because the conflict is "may
 *    this person decide on their own work".
 * 3. **Publishing is a scheduled act with a supplied instant.** There is no
 *    `Date.now()` in the module, and `structure.test.ts` greps the source to keep
 *    it that way. The boundary is inclusive and pinned from both sides.
 * 4. **A creator is a `personId`.** `CreatorProfile` and `PlatformAccount` are
 *    projections of a person, keyed on `person.id`. ADR-0018 exists because this
 *    repository had two competing identity models and nothing joined them; a third
 *    would be the same defect with a different name.
 *
 * **Product decision, not a recovered rule.** The legacy repository had no content
 * pipeline — only free-text status columns written by unrelated handlers. The six
 * states, their edges, the platform vocabulary and the minimum scheduling lead time
 * are all designed here.
 *
 * No persistence — `packages/db` owns the tables. No network, and no clock.
 */

export {
  CONTENT_STATES,
  CONTENT_TRANSITIONS,
  IRREVERSIBLE_CONTENT_TRANSITIONS,
  assertCanTransition,
  canTransition,
  isIrreversibleTransition,
  isTerminalState,
  nextStates,
  transitionContent,
} from "./lifecycle.js";
export type { ContentState, ContentTransition, TransitionContentInput } from "./lifecycle.js";

export { approveContent, recordReviewRequest } from "./approval.js";
export type { ApproveContentInput, ContentApproval, RecordReviewRequestInput, ReviewRequest } from "./approval.js";

export { createContentItem } from "./item.js";
export type { ContentItem } from "./item.js";

export { SCHEDULE_MINIMUM_LEAD_MS, isDueForPublication, schedulePublication, unschedulePublication } from "./scheduling.js";
export type {
  PublicationSchedule,
  ScheduleCancellation,
  SchedulePublicationInput,
  UnschedulePublicationInput,
} from "./scheduling.js";

export { PLATFORMS, createCreatorProfile, createPlatformAccount } from "./creator.js";
export type { CreatorProfile, Platform, PlatformAccount } from "./creator.js";