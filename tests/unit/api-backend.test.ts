import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, test, vi } from "vitest";
import { AuthError, NonRetryableError, RetryableError, UsageLimitError } from "@/lib/analysis/backend";
import { createApiBackend, DEFAULT_API_MODEL } from "@/lib/analysis/backends/api";
import { SYSTEM_PROMPT } from "@/lib/analysis/prompt";
import { realBrandAnalysis } from "../helpers/fixtures";

function fakeClient(impl: () => unknown) {
  const parse = vi.fn(async (_params: unknown) => impl());
  return { client: { messages: { parse } } as unknown as Pick<Anthropic, "messages">, parse };
}

const response = (overrides: Record<string, unknown> = {}) => ({
  stop_reason: "end_turn",
  parsed_output: realBrandAnalysis(),
  usage: { input_tokens: 1200, output_tokens: 900 },
  ...overrides,
});

const apiError = (status: number) => Anthropic.APIError.generate(status, { error: { message: "x" } }, "x", new Headers());

describe("createApiBackend", () => {
  test("defaults to Haiku 5.5 and names itself after the model", () => {
    expect(DEFAULT_API_MODEL).toBe("claude-haiku-5-5");
    expect(createApiBackend({ client: fakeClient(() => response()).client }).name).toBe("api:claude-haiku-5-5");
    expect(createApiBackend({ client: fakeClient(() => response()).client, model: "claude-sonnet-5-5" }).name).toBe(
      "api:claude-sonnet-5-5",
    );
  });

  test("requests structured output with the system prompt and user message", async () => {
    const { client, parse } = fakeClient(() => response());
    await createApiBackend({ client }).analyze(SYSTEM_PROMPT, "hello");
    const params = parse.mock.calls[0][0] as any;
    expect(params.model).toBe("claude-haiku-5-5");
    expect(params.system).toBe(SYSTEM_PROMPT);
    expect(params.messages).toEqual([{ role: "user", content: "hello" }]);
    expect(params.max_tokens).toBe(16000);
    expect(params.output_config.format).toBeDefined();
    expect(params).not.toHaveProperty("thinking.budget_tokens");
  });

  test("returns parsed output and usage", async () => {
    const result = await createApiBackend({ client: fakeClient(() => response()).client }).analyze(SYSTEM_PROMPT, "x");
    expect(result).toEqual({ output: realBrandAnalysis(), usage: { inputTokens: 1200, outputTokens: 900 } });
  });

  test("refusal → NonRetryableError", async () => {
    const backend = createApiBackend({ client: fakeClient(() => response({ stop_reason: "refusal", parsed_output: null })).client });
    await expect(backend.analyze(SYSTEM_PROMPT, "x")).rejects.toBeInstanceOf(NonRetryableError);
  });

  test("max_tokens or missing parsed output → RetryableError", async () => {
    for (const r of [response({ stop_reason: "max_tokens" }), response({ parsed_output: null })]) {
      const backend = createApiBackend({ client: fakeClient(() => r).client });
      await expect(backend.analyze(SYSTEM_PROMPT, "x")).rejects.toBeInstanceOf(RetryableError);
    }
  });

  test.each([
    [429, UsageLimitError],
    [401, AuthError],
    [403, AuthError],
    [500, RetryableError],
    [529, RetryableError],
  ])("HTTP %s → %s", async (status, ErrorClass) => {
    const backend = createApiBackend({
      client: fakeClient(() => {
        throw apiError(status);
      }).client,
    });
    await expect(backend.analyze(SYSTEM_PROMPT, "x")).rejects.toBeInstanceOf(ErrorClass);
  });

  test("connection error → RetryableError", async () => {
    const backend = createApiBackend({
      client: fakeClient(() => {
        throw new Anthropic.APIConnectionError({ message: "socket hang up" });
      }).client,
    });
    await expect(backend.analyze(SYSTEM_PROMPT, "x")).rejects.toBeInstanceOf(RetryableError);
  });
});
