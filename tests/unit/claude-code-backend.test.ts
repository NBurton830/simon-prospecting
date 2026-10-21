import { describe, expect, test } from "vitest";
import { AuthError, RetryableError, UsageLimitError } from "@/lib/analysis/backend";
import {
  buildClaudeArgs,
  buildClaudeEnv,
  classifyClaudeCodeOutput,
  createClaudeCodeBackend,
  type ClaudeRunner,
} from "@/lib/analysis/backends/claude-code";
import { analysisJsonSchema } from "@/lib/analysis/schema";
import { SYSTEM_PROMPT } from "@/lib/analysis/prompt";
import { claudeCapture, realBrandAnalysis } from "../helpers/fixtures";

const classify = (name: string) => {
  const { stdout, exitCode } = claudeCapture(name);
  return () => classifyClaudeCodeOutput(stdout, exitCode);
};

describe("buildClaudeArgs", () => {
  const args = () => buildClaudeArgs({ model: "sonnet", systemPrompt: SYSTEM_PROMPT, jsonSchema: analysisJsonSchema() });
  const valueOf = (flag: string) => args()[args().indexOf(flag) + 1];

  test("headless JSON mode without session files", () => {
    expect(args()).toContain("-p");
    expect(valueOf("--output-format")).toBe("json");
    expect(args()).toContain("--no-session-persistence");
  });

  test("passes the schema, system prompt and model", () => {
    expect(JSON.parse(valueOf("--json-schema"))).toEqual(analysisJsonSchema());
    expect(valueOf("--system-prompt")).toBe(SYSTEM_PROMPT);
    expect(valueOf("--model")).toBe("sonnet");
  });

  test("allows only the StructuredOutput tool (an empty list disables --json-schema)", () => {
    expect(valueOf("--tools")).toBe("StructuredOutput");
  });

  test("never uses bare mode (it ignores OAuth tokens) or skips permissions", () => {
    expect(args()).not.toContain("--bare");
    expect(args()).not.toContain("--dangerously-skip-permissions");
  });
});

describe("buildClaudeEnv", () => {
  test("passes only what the CLI needs — never pipeline secrets", () => {
    const env = buildClaudeEnv({
      PATH: "/usr/bin",
      HOME: "/home/runner",
      USER: "runner",
      LOGNAME: "runner",
      CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-x",
      DATABASE_URL: "postgres://secret",
      RAPIDAPI_KEY: "secret",
      ANTHROPIC_API_KEY: "sk-ant-api-secret",
    });
    expect(env).toEqual({
      PATH: "/usr/bin",
      HOME: "/home/runner",
      USER: "runner",
      LOGNAME: "runner",
      CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-x",
    });
  });

  test("omits unset variables instead of passing 'undefined'", () => {
    expect(buildClaudeEnv({ PATH: "/usr/bin" })).toEqual({ PATH: "/usr/bin" });
  });
});

describe("classifyClaudeCodeOutput (real and labeled captures)", () => {
  test("success returns structured_output and token usage", () => {
    const result = classify("success-brand")();
    expect(result.output).toEqual(realBrandAnalysis());
    // input = input_tokens + cache_creation_input_tokens + cache_read_input_tokens
    expect(result.usage).toEqual({ inputTokens: 4 + 8319 + 0, outputTokens: 2867 });
  });

  test("excluded fund is still a success (exclusion is decided later)", () => {
    const result = classify("success-excluded-fund")();
    expect((result.output as any).is_consumer_brand).toBe(false);
    expect(result.usage).toEqual({ inputTokens: 4 + 1835 + 4530, outputTokens: 840 });
  });

  test("schema ignored (no structured_output) → RetryableError", () => {
    expect(classify("success-no-structured-output.DERIVED")).toThrow(RetryableError);
  });

  test("schema-invalid output is returned as-is; the caller validates", () => {
    expect((classify("success-schema-invalid.DERIVED")().output as any).category).toBe("Clean Skincare / Beauty");
  });

  test("invalid token (401) → AuthError", () => {
    expect(classify("auth-invalid-token")).toThrow(AuthError);
  });

  test("not logged in (no status code) → AuthError", () => {
    expect(classify("auth-not-logged-in")).toThrow(AuthError);
  });

  test("429 → UsageLimitError", () => {
    expect(classify("usage-limit-429.SYNTHETIC")).toThrow(UsageLimitError);
  });

  test("plan usage limit without a status code → UsageLimitError", () => {
    expect(classify("usage-limit-plan.SYNTHETIC")).toThrow(UsageLimitError);
  });

  test("server error → RetryableError", () => {
    expect(classify("server-error-500.SYNTHETIC")).toThrow(RetryableError);
  });

  test.each([[""], ["Error: spawn claude ENOENT"], ['{"type":"result"']])("non-JSON stdout %j → RetryableError", (out) => {
    expect(() => classifyClaudeCodeOutput(out, 1)).toThrow(RetryableError);
  });
});

describe("createClaudeCodeBackend", () => {
  function recordingRunner(name: string) {
    const calls: { args: string[]; input: string; env: Record<string, string> }[] = [];
    const run: ClaudeRunner = async (args, input, env) => {
      calls.push({ args, input, env });
      return claudeCapture(name);
    };
    return { run, calls };
  }

  test("sends the user message on stdin with a stripped environment", async () => {
    const { run, calls } = recordingRunner("success-brand");
    const backend = createClaudeCodeBackend({
      model: "sonnet",
      run,
      env: { PATH: "/usr/bin", HOME: "/h", CLAUDE_CODE_OAUTH_TOKEN: "t", DATABASE_URL: "postgres://secret" },
    });
    const result = await backend.analyze(SYSTEM_PROMPT, "<company>…</company>");
    expect(result.output).toEqual(realBrandAnalysis());
    expect(calls).toHaveLength(1);
    expect(calls[0].input).toBe("<company>…</company>");
    expect(calls[0].env).not.toHaveProperty("DATABASE_URL");
    expect(calls[0].args).toContain("StructuredOutput");
  });

  test("names itself after the model (stored in prospects.model)", () => {
    expect(createClaudeCodeBackend({ model: "sonnet", run: recordingRunner("success-brand").run }).name).toBe(
      "claude-code:sonnet",
    );
  });

  test("propagates classified errors", async () => {
    const backend = createClaudeCodeBackend({ model: "sonnet", run: recordingRunner("auth-invalid-token").run });
    await expect(backend.analyze(SYSTEM_PROMPT, "x")).rejects.toBeInstanceOf(AuthError);
  });

  test("a runner failure (spawn error, timeout) → RetryableError", async () => {
    const backend = createClaudeCodeBackend({
      model: "sonnet",
      run: async () => {
        throw new Error("spawn claude ETIMEDOUT");
      },
    });
    await expect(backend.analyze(SYSTEM_PROMPT, "x")).rejects.toBeInstanceOf(RetryableError);
  });
});
