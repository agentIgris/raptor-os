/**
 * Offline answer composer — the default mode of the assistant.
 *
 * Until a language-model provider is configured (`ASSISTANT_*` env vars),
 * the assistant does not attempt to interpret the question. It runs every
 * tool the caller's role allows, returns the raw structured results, and
 * labels the response so the user knows a model was not involved. That keeps
 * the capability available immediately while making the absence of a model
 * impossible to mistake for a model answer.
 */

import type { AssistantRole, AssistantToolName } from "./matrix.js";
import type { ToolResult } from "./tools.js";

export const OFFLINE_DISCLAIMER =
  "No language model is configured for this workspace, so the assistant returned the requested workspace data directly. Every figure comes live from the tenant database; no model summarization was applied.";

export interface OfflineSection {
  tool: AssistantToolName;
  status: "ok" | "error" | "skipped";
  data?: unknown;
  error?: string;
}

export interface OfflineToolOutcome {
  tool: AssistantToolName;
  /** `null` means the tool was not run (not allowed for this role). */
  result: ToolResult<unknown> | null;
}

export interface OfflineAnswer {
  mode: "offline";
  question: string;
  role: AssistantRole;
  sections: OfflineSection[];
  disclaimer: string;
}

export function composeOfflineAnswer(
  question: string,
  role: AssistantRole,
  outcomes: readonly OfflineToolOutcome[],
): OfflineAnswer {
  return {
    mode: "offline",
    question,
    role,
    disclaimer: OFFLINE_DISCLAIMER,
    sections: outcomes.map((outcome) => {
      const { result } = outcome;
      if (result === null) {
        return { tool: outcome.tool, status: "skipped" as const };
      }
      if (result.ok) {
        return {
          tool: outcome.tool,
          status: "ok" as const,
          data: result.data,
        };
      }
      return {
        tool: outcome.tool,
        status: "error" as const,
        error: result.error,
      };
    }),
  };
}
