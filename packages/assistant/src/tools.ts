/**
 * Assistant tool contract and registry.
 *
 * A "tool" is a named, read-only data function the assistant may run for the
 * signed-in session. The package stays pure: it never imports the database,
 * the web app, or Better Auth. `apps/web` injects the concrete `run`
 * implementations (each one goes through `withOrg`, so RLS scopes every
 * query to the caller's org) and assembles the registry at request time.
 *
 * Authorization has exactly one authority: `TOOL_SCOPES` in `matrix.ts`.
 * `makeTool` copies the scope out of the matrix so a tool cannot drift from
 * it, and `filterForRole` consults the matrix again when selecting tools for
 * a session, failing closed on any role string it does not recognize.
 */

import {
  ASSISTANT_ROLES,
  TOOL_SCOPES,
  toolsForRole,
  type AssistantRole,
  type AssistantToolName,
} from "./matrix.js";

export interface AssistantSession {
  userId: string;
  email: string;
  role: AssistantRole;
  orgId: string;
}

export type ToolResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string };

export interface AssistantToolRequest {
  session: AssistantSession;
  question: string;
}

export interface AssistantTool {
  name: AssistantToolName;
  description: string;
  allowedRoles: readonly AssistantRole[];
  run(request: AssistantToolRequest): Promise<ToolResult<unknown>>;
}

export type ToolRegistry = ReadonlyMap<AssistantToolName, AssistantTool>;

/** Derive `allowedRoles` from the matrix so tools cannot declare their own. */
export function makeTool(
  tool: Pick<AssistantTool, "name" | "description" | "run">,
): AssistantTool {
  return { ...tool, allowedRoles: TOOL_SCOPES[tool.name] };
}

/** Last registration wins; an empty list yields an empty registry. */
export function makeRegistry(
  tools: readonly AssistantTool[],
): ToolRegistry {
  const registry = new Map<AssistantToolName, AssistantTool>();
  for (const tool of tools) {
    registry.set(tool.name, tool);
  }
  return registry;
}

/**
 * Tools the given role may run, in canonical matrix order. Unknown roles
 * (including forged or stale session roles) yield an empty list.
 */
export function filterForRole(
  registry: ToolRegistry,
  role: string,
): AssistantTool[] {
  const isKnownRole = ASSISTANT_ROLES.some((candidate) => candidate === role);
  if (!isKnownRole) {
    return [];
  }
  const selected: AssistantTool[] = [];
  for (const name of toolsForRole(role as AssistantRole)) {
    const tool = registry.get(name);
    if (tool) {
      selected.push(tool);
    }
  }
  return selected;
}
