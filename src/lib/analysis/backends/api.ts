import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import {
  AuthError,
  NonRetryableError,
  RetryableError,
  UsageLimitError,
  type AnalysisBackend,
} from "@/lib/analysis/backend";
import { AnalysisSchema } from "@/lib/analysis/schema";

export const DEFAULT_API_MODEL = "claude-haiku-5-5";

// Calls client.messages.parse with zodOutputFormat(AnalysisSchema) and max_tokens 16000. name: "api:<model>".
// - stop_reason "refusal"                         → NonRetryableError
// - stop_reason "max_tokens" or no parsed_output  → RetryableError
// - RateLimitError                                → UsageLimitError
// - AuthenticationError / PermissionDeniedError   → AuthError
// - other APIError / APIConnectionError           → RetryableError
export function createApiBackend(opts: {
  client: Pick<Anthropic, "messages">;
  model?: string;
}): AnalysisBackend {
  const model = opts.model ?? DEFAULT_API_MODEL;
  return {
    name: `api:${model}`,
    async analyze(systemPrompt, userMessage) {
      let response;
      try {
        response = await opts.client.messages.parse({
          model,
          max_tokens: 16000,
          system: systemPrompt,
          messages: [{ role: "user", content: userMessage }],
          output_config: { format: zodOutputFormat(AnalysisSchema) },
        });
      } catch (err) {
        const message = (err as Error).message;
        if (err instanceof Anthropic.RateLimitError) throw new UsageLimitError(message);
        if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
          throw new AuthError(message);
        }
        throw new RetryableError(message);
      }

      if (response.stop_reason === "refusal") throw new NonRetryableError("Claude declined the request (refusal)");
      if (response.stop_reason === "max_tokens" || !response.parsed_output) {
        throw new RetryableError(`incomplete output (stop_reason: ${response.stop_reason})`);
      }
      return {
        output: response.parsed_output,
        usage: { inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens },
      };
    },
  };
}
