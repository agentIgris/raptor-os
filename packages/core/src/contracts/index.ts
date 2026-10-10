/**
 * Contracts: immutable versions, provable acceptance, an explicit lifecycle.
 *
 * The phase's acceptance criterion is *"Acceptance provable by content hash"*.
 * These five ideas together are what make it true rather than aspirational:
 *
 * 1. **Versions are immutable and self-hashing.** `hashContractVersion` covers
 *    the whole document through a length-framed encoding, so no two different
 *    contracts can produce the same bytes — including under an attack that moves
 *    a character across a field boundary.
 * 2. **Acceptance names a hash.** It is a value, not a boolean on the contract,
 *    so acceptance of version N is provably not acceptance of version N+1.
 * 3. **Withdrawal appends.** It never erases the acceptance it revokes.
 * 4. **The lifecycle is a table.** `canTransition` is pure, total, and derived
 *    from a single source of truth; irreversibility is derived from the table and
 *    pinned in tests.
 * 5. **Amendment is a new version.** There is no edit path in this package.
 *
 * No persistence — `packages/db` owns the tables. No network, and no clock:
 * every instant that matters is a parameter, so a decision taken for a past date
 * can be reproduced exactly.
 */

export { amendContract, amendmentChain, isAmendedFrom } from "./amendment.js";
export type { AmendContractInput, Amendment } from "./amendment.js";

export {
  CONTRACT_STATES,
  CONTRACT_TRANSITIONS,
  IRREVERSIBLE_TRANSITIONS,
  assertCanTransition,
  canTransition,
  isIrreversibleTransition,
  isTerminalState,
  nextStates,
  transitionContract,
} from "./lifecycle.js";
export type { ContractState, LifecycleTransition, TransitionContractInput } from "./lifecycle.js";

export {
  CONTRACT_HASH_ALGORITHM,
  assertContractVersionVerified,
  canonicalFrame,
  canonicalizeContractVersion,
  createContractVersion,
  encodeContractVersion,
  hashContractVersion,
  verifyContractVersion,
} from "./version.js";
export type {
  ContractClause,
  ContractVersion,
  ContractVersionContent,
  CreateContractVersionInput,
} from "./version.js";

export {
  createAcceptance,
  findEffectiveAcceptance,
  findUnexpiredAcceptance,
  recordRefusal,
  withdrawalMatchesAcceptance,
  withdrawAcceptance,
} from "./version-acceptance.js";
export type {
  Acceptance,
  AcceptanceRefusal,
  AcceptanceWithdrawal,
  CreateAcceptanceInput,
  RecordRefusalInput,
  RefusalReason,
  WithdrawalReason,
  WithdrawAcceptanceInput,
} from "./version-acceptance.js";