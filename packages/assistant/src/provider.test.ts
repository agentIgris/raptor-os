import { describe, expect, it } from "vitest";

import { PROVIDER_TIMEOUT_MS, askProvider, readProviderConfig } from "./provider.js";
import type { AskProviderInput } from "./provider.js";

const config = {
  baseUrl: "https://llm.example.test/v1",
  apiKey: "sk-test",
  model: "test-model",
};

type FetchCall = { url: string; init: RequestInit };

function captureFetch(
  respond: (call: FetchCall) => Response,
): { calls: FetchCall[]; fetchFn: typeof fetch } {
  const calls: FetchCall[] = [];
  const fetchFn = ((url: string, init?: RequestInit) => {
    calls.push({ url, init: init ?? {} });
    return Promise.resolve(respond(calls[calls.length - 1]!));
  }) as unknown as typeof fetch;
  return { calls, fetchFn };
}

function jsonFetch(status: number, payload: unknown): typeof fetch {
  return captureFetch(
    () =>
      new Response(JSON.stringify(payload), {
        status,
        headers: { "content-type": "application/json" },
      }),
  ).fetchFn;
}

const baseInput: Omit<AskProviderInput, "fetchFn"> = {
  config,
  systemPrompt: "system",
  userMessage: "question",
};

describe("readProviderConfig", () => {
  it("returns null when any of the three variables is missing", () => {
    expect(readProviderConfig({})).toBeNull();
    expect(readProviderConfig({ ASSISTANT_BASE_URL: "https://x" })).toBeNull();
    expect(
      readProviderConfig({
        ASSISTANT_BASE_URL: "https://x",
        ASSISTANT_API_KEY: "k",
      }),
    ).toBeNull();
  });

  it("treats empty strings as missing", () => {
    expect(
      readProviderConfig({
        ASSISTANT_BASE_URL: "",
        ASSISTANT_API_KEY: "k",
        ASSISTANT_MODEL: "m",
      }),
    ).toBeNull();
  });

  it("returns the full config when everything is present", () => {
    expect(
      readProviderConfig({
        ASSISTANT_BASE_URL: "https://x",
        ASSISTANT_API_KEY: "k",
        ASSISTANT_MODEL: "m",
        IGNORED: "ignored",
      }),
    ).toEqual({ baseUrl: "https://x", apiKey: "k", model: "m" });
  });
});

describe("askProvider", () => {
  it("posts an OpenAI-compatible chat completion with bearer auth", async () => {
    const { calls, fetchFn } = captureFetch(
      () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: "hello" } }],
          }),
          { status: 200 },
        ),
    );
    const answer = await askProvider({ ...baseInput, fetchFn });
    expect(answer).toBe("hello");
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe("https://llm.example.test/v1/chat/completions");
    expect(call.init.method).toBe("POST");
    const headers = call.init.headers as Record<string, string>;
    expect(headers["content-type"]).toBe("application/json");
    expect(headers.authorization).toBe("Bearer sk-test");
    const body = JSON.parse(call.init.body as string) as {
      model: string;
      messages: Array<{ role: string; content: string }>;
    };
    expect(body.model).toBe("test-model");
    expect(body.messages).toEqual([
      { role: "system", content: "system" },
      { role: "user", content: "question" },
    ]);
    expect((call.init.signal as AbortSignal).aborted).toBe(false);
  });

  it("rejects non-2xx responses with the status code", async () => {
    await expect(
      askProvider({ ...baseInput, fetchFn: jsonFetch(401, {}) }),
    ).rejects.toThrow("provider request failed with status 401");
    await expect(
      askProvider({ ...baseInput, fetchFn: jsonFetch(500, {}) }),
    ).rejects.toThrow("provider request failed with status 500");
  });

  it("rejects responses without usable assistant content", async () => {
    await expect(
      askProvider({ ...baseInput, fetchFn: jsonFetch(200, {}) }),
    ).rejects.toThrow("provider response contained no assistant content");
    await expect(
      askProvider({ ...baseInput, fetchFn: jsonFetch(200, { choices: [] }) }),
    ).rejects.toThrow("provider response contained no assistant content");
    await expect(
      askProvider({
        ...baseInput,
        fetchFn: jsonFetch(200, { choices: [{ message: { content: 42 } }] }),
      }),
    ).rejects.toThrow("provider response contained no assistant content");
    await expect(
      askProvider({
        ...baseInput,
        fetchFn: jsonFetch(200, { choices: [{ message: { content: "" } }] }),
      }),
    ).rejects.toThrow("provider response contained no assistant content");
  });

  it("honors a custom timeout", async () => {
    const { calls, fetchFn } = captureFetch(
      () =>
        new Response(JSON.stringify({ choices: [{ message: { content: "x" } }] }), {
          status: 200,
        }),
    );
    await askProvider({ ...baseInput, fetchFn, timeoutMs: 1_000 });
    const call = calls[0]!;
    expect((call.init.signal as AbortSignal).aborted).toBe(false);
  });

  it("defaults to the 30s provider timeout", () => {
    expect(PROVIDER_TIMEOUT_MS).toBe(30_000);
  });
});
