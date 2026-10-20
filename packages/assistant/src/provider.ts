/**
 * Optional OpenAI-compatible provider for the assistant.
 *
 * The provider is strictly opt-in: it activates only when all three
 * `ASSISTANT_BASE_URL`, `ASSISTANT_API_KEY`, and `ASSISTANT_MODEL` env vars
 * are present. Any failure (missing config, non-2xx status, malformed body,
 * empty answer, timeout) surfaces as an exception the route catches by
 * falling back to `composeOfflineAnswer` — the workspace never becomes
 * unusable because a model endpoint is down.
 *
 * Deliberately minimal: plain `fetch`, non-streaming, fixed 30s timeout, and
 * no SDK dependency, so the package stays runtime-pure and testable with an
 * injected `fetchFn`.
 */

export interface ProviderConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export type ProviderEnv = Record<string, string | undefined>;

export const PROVIDER_TIMEOUT_MS = 30_000;

export function readProviderConfig(env: ProviderEnv): ProviderConfig | null {
  const baseUrl = env.ASSISTANT_BASE_URL;
  const apiKey = env.ASSISTANT_API_KEY;
  const model = env.ASSISTANT_MODEL;
  if (!baseUrl || !apiKey || !model) {
    return null;
  }
  return { baseUrl, apiKey, model };
}

export interface AskProviderInput {
  config: ProviderConfig;
  systemPrompt: string;
  userMessage: string;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}

interface ProviderCompletionResponse {
  choices?: ReadonlyArray<{ message?: { content?: unknown } }>;
}

export async function askProvider(input: AskProviderInput): Promise<string> {
  const fetchFn = input.fetchFn ?? fetch;
  const timeoutMs = input.timeoutMs ?? PROVIDER_TIMEOUT_MS;
  const response = await fetchFn(`${input.config.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${input.config.apiKey}`,
    },
    body: JSON.stringify({
      model: input.config.model,
      messages: [
        { role: "system", content: input.systemPrompt },
        { role: "user", content: input.userMessage },
      ],
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new Error(`provider request failed with status ${response.status}`);
  }
  const payload = (await response.json()) as ProviderCompletionResponse;
  const content = payload.choices?.[0]?.message?.content;
  if (typeof content !== "string" || content.length === 0) {
    throw new Error("provider response contained no assistant content");
  }
  return content;
}
