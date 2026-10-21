import type { AnalysisBackend, AnalysisResult } from "@/lib/analysis/backend";

type Step = AnalysisResult | Error | ((userMessage: string) => AnalysisResult | Error);

// Scriptable backend: each call consumes the next step (the last step repeats).
export function fakeBackend(steps: Step[], name = "fake:test") {
  const calls: { systemPrompt: string; userMessage: string }[] = [];
  const backend: AnalysisBackend = {
    name,
    async analyze(systemPrompt, userMessage) {
      calls.push({ systemPrompt, userMessage });
      const step = steps[Math.min(calls.length - 1, steps.length - 1)];
      const result = typeof step === "function" ? step(userMessage) : step;
      if (result instanceof Error) throw result;
      return result;
    },
  };
  return { backend, calls };
}
