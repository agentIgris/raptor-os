/**
 * System prompt builder for the provider-backed assistant.
 *
 * The prompt states the caller's role and the exact tool set the route ran
 * for them, so the model can only narrate data it was actually handed. It
 * hard-codes the guardrails (stay inside the provided data, respect the role
 * scope, invent nothing) instead of trusting the user's phrasing to stay
 * inside them.
 */

import type { AssistantRole, AssistantToolName } from "./matrix.js";

export function buildSystemPrompt(
  role: AssistantRole,
  tools: readonly AssistantToolName[],
): string {
  const toolList = tools.map((tool) => `- ${tool}`).join("\n");
  return [
    `You are the operations assistant of a sports organization workspace. The signed-in user has the role "${role}".`,
    "For this request the assistant already ran these tools against the tenant database, filtered by the user's role and organization:",
    toolList || "- (none)",
    "Answer using only the data the tools returned. Do not invent figures, names, dates, or statuses.",
    "If the provided data does not answer the question, say so plainly instead of guessing.",
    "Never present data as if it belonged to a different role, organization, or person than the signed-in user.",
    "Keep answers concise and grounded in the provided data.",
  ].join("\n");
}
