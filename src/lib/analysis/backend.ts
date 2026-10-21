export interface AnalysisResult {
  output: unknown; // validated by the caller with AnalysisSchema.parse()
  usage?: { inputTokens: number; outputTokens: number };
}

export interface AnalysisBackend {
  name: string; // stored in prospects.model, e.g. "claude-code:sonnet"
  analyze(systemPrompt: string, userMessage: string): Promise<AnalysisResult>;
}

// Plan allowance or rate limit hit: stop the run, carry the brand over without counting an attempt.
export class UsageLimitError extends Error {
  name = "UsageLimitError";
}

// Missing, expired, or revoked credentials: stop the run, carry the brand over without counting an attempt.
export class AuthError extends Error {
  name = "AuthError";
}

// Transient or malformed output: count the attempt and retry on a later run (FAILED after 3 attempts).
export class RetryableError extends Error {
  name = "RetryableError";
}

// Will not succeed on retry (e.g. a refusal): mark this brand FAILED immediately and continue.
export class NonRetryableError extends Error {
  name = "NonRetryableError";
}
