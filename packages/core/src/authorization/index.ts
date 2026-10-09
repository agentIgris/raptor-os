export { SCOPE_RANK, SCOPE_TYPES, compareScopeRank, scopeCovers, scopeRank, scopeTypesByBreadth } from "./scopes.js";
export type { ScopeType } from "./scopes.js";

export { ACTIONS, RESOURCES, isAction, isPermission, isResource, parsePermission, permission } from "./permissions.js";
export type { Action, Permission, Resource } from "./permissions.js";

export {
  assertScopePermitted,
  assignmentActiveAt,
  createAssignment,
  createRole,
  isAssignmentActive,
  maxAssignment,
  rolePermitsScope,
  validateAssignmentScope,
} from "./model.js";
export type { AssignmentDraft, Role, RoleAssignment, RoleDraft } from "./model.js";

export { evaluateCondition, ruleMatches } from "./policy.js";
export type { ConditionContext, MonetaryAmount, PolicyCondition, PolicyRule } from "./policy.js";

export { evaluate, isAllowed, isDenied } from "./evaluate.js";
export type { Actor, AuthorizationRequest, Decision, DenialReason, AllowReason, ScopeRef } from "./evaluate.js";

export { compileMatrix, matrixToNavigation, matrixToRlsPolicies } from "./matrix.js";
export type { MatrixRow, PolicyMatrix } from "./matrix.js";