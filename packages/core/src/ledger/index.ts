/**
 * Ledger: pure double-entry posting logic.
 *
 * No persistence. `packages/db` owns the tables; this owns the rule that a
 * posting must balance before it is allowed to exist. See `./journal.js` for
 * the reasoning behind the balance invariant, the conservation check, the
 * structural immutability guarantee and the multi-currency policy.
 */

export {
  assertLedgerBalances,
  ledgerGrandTotals,
  postJournal,
  reverseJournal,
} from "./journal.js";

export type {
  AppliedConversion,
  CurrencyTotals,
  Direction,
  FxConversion,
  JournalLine,
  PostJournalInput,
  PostedJournal,
  PostedLine,
  ReverseJournalOptions,
} from "./journal.js";