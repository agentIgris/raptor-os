/**
 * Policy rules and conditions — the ABAC overlay.
 *
 * RBAC answers "may this role do this, here". It cannot answer "may this role
 * approve *their own* invoice", which is why the legacy system had no
 * separation of duties at all (`AUDIT/10_AUTHORIZATION.md`: "Separation of
 * duties: no"). The overlay is deliberately small — three condition kinds — and
 * data-shaped rather than code-shaped, so a rule can be stored, reviewed and
 * mirrored in RLS.
 *
 * Money conditions use {@link Money}, never a float: "approve below 10,000"
 * evaluated against `double precision` is a limit that moves.
 */

import type { CurrencyCode } from "../money/index.js";
import type { Action, Resource } from "./permissions.js";
import type { ScopeType } from "./scopes.js";

/** An exact monetary amount. Mirrors `Money` so callers can pass one straight through. */
export interface MonetaryAmount {
  readonly minor: bigint;
  readonly currency: CurrencyCode;
}

/**
 * A condition a request must satisfy.
 *
 * A condition that cannot be evaluated — because the request carries no amount,
 * or the currencies differ — evaluates to **false**, not to "skip". Failing
 * closed is the only safe default for a rule that exists to stop something.
 */
export type PolicyCondition =
  /** The actor is the resource's owner. Used for `requester != approver` rules. */
  | { readonly kind: "actor_equals_owner" }
  /**
   * The amount under evaluation is within the limit, same currency. Inclusive at
   * the limit, so "approve up to 10,000" approves exactly 10,000.
   *
   * `amount` is a fallback for callers that cannot supply one on the request; a
   * request-supplied amount always takes precedence.
   */
  | { readonly kind: "amount_within_limit"; readonly limit: MonetaryAmount; readonly amount?: MonetaryAmount };

/** A single rule, matched on resource, action and optionally scope type. */
export interface PolicyRule {
  /** Durable stable id, recorded on the decision so a denial names the rule. */
  readonly id: string;
  readonly resource: Resource;
  readonly action: Action;
  readonly effect: "ALLOW" | "DENY";
  readonly condition: PolicyCondition;
  /** When present, the rule applies only within these scope types. */
  readonly scopeTypes?: readonly ScopeType[];
}

/** The facts a condition is evaluated against. */
export interface ConditionContext {
  readonly actorId?: string;
  readonly resourceOwnerId?: string;
  readonly amount?: MonetaryAmount;
}

/**
 * Evaluate a condition.
 *
 * Never throws: a comparison it cannot make is a condition it cannot satisfy.
 */
export function evaluateCondition(condition: PolicyCondition, context: ConditionContext): boolean {
  switch (condition.kind) {
    case "actor_equals_owner":
      return context.actorId !== undefined && context.resourceOwnerId !== undefined && context.actorId === context.resourceOwnerId;
    case "amount_within_limit": {
      // The request's own amount wins over the condition's fallback: the value
      // being authorised is the one under evaluation, and a rule-supplied amount
      // is only a default for callers that could not supply one.
      const amount = context.amount ?? condition.amount;
      if (amount === undefined) return false;
      if (amount.currency !== condition.limit.currency) return false;
      return amount.minor <= condition.limit.minor;
    }
  }
}

/** Whether a rule applies to this resource/action, and optionally this scope. */
export function ruleMatches(
  rule: PolicyRule,
  resource: Resource,
  action: Action,
  scopeType: ScopeType,
): boolean {
  if (rule.resource !== resource || rule.action !== action) return false;
  if (rule.scopeTypes !== undefined && !rule.scopeTypes.includes(scopeType)) return false;
  return true;
}