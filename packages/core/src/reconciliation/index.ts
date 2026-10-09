/**
 * Reconciliation: pool invariants, ledger correspondence, and the stored-input
 * replay that makes an allocation verifiable months later.
 */

export { assertReconciled, reconcile } from "./reconcile.js";
export type { ReconcileInput, ReconciliationReport, ReconciliationStatus } from "./reconcile.js";

export {
  SNAPSHOT_SCHEMA,
  allocationSnapshotHash,
  buildAllocationSnapshot,
  digestAllocationRows,
  replayAllocationFromSnapshot,
  verifyAllocationSnapshot,
} from "./replay.js";
export type {
  AllocationSnapshot,
  ReplayOptions,
  ReplayResult,
  SnapshotEntry,
  SnapshotParticipant,
  SnapshotRule,
  StoredAllocationRow,
  VerificationResult,
  VerifyAllocationInput,
} from "./replay.js";