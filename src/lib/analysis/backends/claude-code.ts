import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AuthError,
  RetryableError,
  UsageLimitError,
  type AnalysisBackend,
  type AnalysisResult,
} from "@/lib/analysis/backend";
import { analysisJsonSchema } from "@/lib/analysis/schema";

const RUN_TIMEOUT_MS = 180_000;
const PASSTHROUGH_ENV = ["PATH", "HOME", "USER", "LOGNAME", "CLAUDE_CODE_OAUTH_TOKEN"] as const;

export interface ClaudeArgsOptions {
  model: string;
  systemPrompt: string;
  jsonSchema: Record<string, unknown>;
}

// -p --output-format json --json-schema <schema> --system-prompt <prompt>
// --tools StructuredOutput --model <model> --no-session-persistence
// (Never --bare: bare mode ignores OAuth tokens. Never --tools "": it disables --json-schema.)
export function buildClaudeArgs(opts: ClaudeArgsOptions): string[] {
  return [
    "-p",
    "--output-format", "json",
    "--json-schema", JSON.stringify(opts.jsonSchema),
    "--system-prompt", opts.systemPrompt,
    "--tools", "StructuredOutput",
    "--model", opts.model,
    "--no-session-persistence",
  ];
}

// Only PATH, HOME, USER, LOGNAME (macOS keychain login) and CLAUDE_CODE_OAUTH_TOKEN, when set.
export function buildClaudeEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of PASSTHROUGH_ENV) {
    const value = env[key];
    if (value) out[key] = value;
  }
  return out;
}

// The fields of `claude -p --output-format json` output that the classifier reads.
interface ClaudeJsonResult {
  is_error?: boolean;
  api_error_status?: number | null;
  result?: unknown;
  structured_output?: unknown;
  usage?: {
    input_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
    output_tokens?: number;
  };
}

const USAGE_LIMIT_TEXT = /usage limit|rate limit|limit reached|too many requests/i;
const AUTH_TEXT = /not logged in|\/login|authenticat|oauth|invalid api key|unauthorized/i;

// Classifies one `claude -p --output-format json` result. Classify by `is_error`, not `subtype`
// (errors report subtype "success").
// - Not JSON                                          → RetryableError
// - is_error, status 429 or usage/rate limit wording  → UsageLimitError
// - is_error, status 401/403 or login/auth wording    → AuthError
// - is_error, anything else                           → RetryableError
// - no structured_output                              → RetryableError (schema was ignored)
// - otherwise → { output: structured_output, usage } (input = input + cache creation + cache read tokens)
export function classifyClaudeCodeOutput(stdout: string, exitCode: number | null): AnalysisResult {
  let parsed: ClaudeJsonResult | null;
  try {
    parsed = JSON.parse(stdout) as ClaudeJsonResult | null;
  } catch {
    throw new RetryableError(`claude exited ${exitCode} without JSON output: ${stdout.slice(0, 200)}`);
  }
  if (!parsed || typeof parsed !== "object") throw new RetryableError("claude returned a non-object result");

  if (parsed.is_error) {
    const status = parsed.api_error_status;
    const message = String(parsed.result ?? "unknown error").slice(0, 500);
    if (status === 429 || USAGE_LIMIT_TEXT.test(message)) throw new UsageLimitError(message);
    if (status === 401 || status === 403 || AUTH_TEXT.test(message)) throw new AuthError(message);
    throw new RetryableError(message);
  }

  if (parsed.structured_output === undefined || parsed.structured_output === null) {
    throw new RetryableError("claude returned no structured_output (the JSON schema was ignored)");
  }

  const u = parsed.usage ?? {};
  return {
    output: parsed.structured_output,
    usage: {
      inputTokens: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0),
      outputTokens: u.output_tokens ?? 0,
    },
  };
}

export type ClaudeRunner = (
  args: string[],
  input: string,
  env: Record<string, string>,
) => Promise<{ stdout: string; exitCode: number | null }>;

// Spawns `claude` in an empty temp dir so no CLAUDE.md or project settings are picked up.
export const spawnClaude: ClaudeRunner = (args, input, env) =>
  new Promise((resolve, reject) => {
    const cwd = mkdtempSync(join(tmpdir(), "claude-run-"));
    const child = spawn("claude", args, { cwd, env: env as NodeJS.ProcessEnv, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), RUN_TIMEOUT_MS);
    const cleanup = () => {
      clearTimeout(timer);
      rmSync(cwd, { recursive: true, force: true });
    };
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.resume();
    child.on("error", (err) => {
      cleanup();
      reject(err);
    });
    child.on("close", (code, signal) => {
      cleanup();
      if (signal) reject(new Error(`claude killed by ${signal} (timeout ${RUN_TIMEOUT_MS / 1000}s)`));
      else resolve({ stdout, exitCode: code });
    });
    child.stdin.end(input);
  });

// name: "claude-code:<model>". `run` defaults to spawning `claude` in an empty temp dir with a 180s timeout.
export function createClaudeCodeBackend(opts: {
  model?: string;
  run?: ClaudeRunner;
  env?: Record<string, string | undefined>; // defaults to process.env
} = {}): AnalysisBackend {
  const model = opts.model ?? process.env.CLAUDE_CODE_MODEL ?? "sonnet";
  const run = opts.run ?? spawnClaude;
  const env = buildClaudeEnv(opts.env ?? process.env);
  return {
    name: `claude-code:${model}`,
    async analyze(systemPrompt, userMessage) {
      const args = buildClaudeArgs({ model, systemPrompt, jsonSchema: analysisJsonSchema() });
      let result: { stdout: string; exitCode: number | null };
      try {
        result = await run(args, userMessage, env);
      } catch (err) {
        throw new RetryableError(`claude failed to run: ${(err as Error).message}`);
      }
      return classifyClaudeCodeOutput(result.stdout, result.exitCode);
    },
  };
}
