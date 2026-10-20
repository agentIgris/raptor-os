/**
 * `POST /api/assistant` — the one entry point for asking the assistant.
 *
 * Authorisation is fail-closed in three steps before any data is read: a
 * signed-in session, a tenant to read within, and a role the tool matrix
 * grants tools to. `pending` and unknown roles therefore get a 403 without a
 * single workspace read, regardless of what the client sends.
 *
 * Answers are offline-first: the workspace tools always run and the offline
 * answer is always composed, and only when a model is fully configured do we
 * try to paraphrase it. If the model call fails the offline answer ships
 * anyway — a broken language model must not take workspace data dark with it.
 */

import {
  askProvider,
  buildSystemPrompt,
  composeOfflineAnswer,
  filterForRole,
  readProviderConfig,
  type AssistantRole,
  type AssistantSession,
  type OfflineToolOutcome,
} from "@raptor/assistant";
import { logger } from "@raptor/observability";

import { buildAssistantRegistry, type AssistantAnswer, type ProviderAnswer } from "../../../server/assistant";
import { getCurrentSession } from "../../../server/session";

export const dynamic = "force-dynamic";

const MAX_QUESTION_LENGTH = 2_000;

const NO_STORE: HeadersInit = { "cache-control": "no-store" };

function questionOf(body: unknown): string {
  if (typeof body !== "object" || body === null) return "";
  const question = (body as { question?: unknown })["question"];
  return typeof question === "string" ? question : "";
}

export async function POST(request: Request): Promise<Response> {
  const session = await getCurrentSession();
  if (session === null) {
    return Response.json({ error: "Sign in to use the assistant." }, { status: 401, headers: NO_STORE });
  }
  if (session.orgId === null) {
    return Response.json({ error: "No active organisation for this session." }, { status: 403, headers: NO_STORE });
  }

  let body: unknown = null;
  try {
    body = await request.json();
  } catch {
    // Malformed JSON falls through and is rejected by the question check.
  }
  const question = questionOf(body).trim();
  if (question === "" || question.length > MAX_QUESTION_LENGTH) {
    return Response.json(
      { error: `Ask one question of 1 to ${MAX_QUESTION_LENGTH} characters.` },
      { status: 400, headers: NO_STORE },
    );
  }

  // `session.role` is a plain string from the database. The cast is honest
  // here: `filterForRole` fails closed on any role the matrix does not know,
  // and an empty tool list below is a 403, so an unknown role never reaches a
  // tool, the database or a model.
  const role = session.role as AssistantRole;
  const tools = filterForRole(buildAssistantRegistry(), role);
  if (tools.length === 0) {
    return Response.json(
      { error: "Your account's role cannot use the assistant." },
      { status: 403, headers: NO_STORE },
    );
  }

  const assistantSession: AssistantSession = {
    userId: session.userId,
    email: session.email,
    role,
    orgId: session.orgId,
  };

  // Sequential on purpose: the pool is small and one question has no reason to
  // open a connection per tool at once.
  const outcomes: OfflineToolOutcome[] = [];
  for (const tool of tools) {
    outcomes.push({ tool: tool.name, result: await tool.run({ session: assistantSession, question }) });
  }
  const offline = composeOfflineAnswer(question, role, outcomes);

  const config = readProviderConfig(process.env);
  if (config === null) {
    return Response.json(offline satisfies AssistantAnswer, { headers: NO_STORE });
  }

  try {
    const answer = await askProvider({
      config,
      systemPrompt: buildSystemPrompt(role, tools.map((tool) => tool.name)),
      userMessage: question,
    });
    const providerAnswer: ProviderAnswer = { mode: "provider", question, role, answer };
    return Response.json(providerAnswer satisfies AssistantAnswer, { headers: NO_STORE });
  } catch (error) {
    logger.warn("assistant.provider_fallback", {
      reason: error instanceof Error ? error.message : "unknown error",
    });
    return Response.json(offline satisfies AssistantAnswer, { headers: NO_STORE });
  }
}
