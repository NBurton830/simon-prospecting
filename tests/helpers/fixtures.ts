import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../scripts/fixtures/", import.meta.url));

export function fixtureText(path: string): string {
  return readFileSync(ROOT + path, "utf8");
}

export function fixtureJson<T = any>(path: string): T {
  return JSON.parse(fixtureText(path)) as T;
}

// A real `claude -p` capture: stdout plus the exit code recorded next to it (DERIVED/SYNTHETIC files use 1 for errors).
export function claudeCapture(name: string): { stdout: string; exitCode: number } {
  const stdout = fixtureText(`claude-code/${name}.stdout.json`);
  let exitCode = JSON.parse(stdout).is_error ? 1 : 0;
  try {
    exitCode = fixtureJson(`claude-code/${name}.meta.json`).exitCode;
  } catch {
    // derived and synthetic fixtures have no meta file
  }
  return { stdout, exitCode };
}

// structured_output of the real successful brand capture: a valid Analysis.
export function realBrandAnalysis(): Record<string, any> {
  return structuredClone(fixtureJson("claude-code/success-brand.stdout.json").structured_output);
}

export function realExcludedAnalysis(): Record<string, any> {
  return structuredClone(fixtureJson("claude-code/success-excluded-fund.stdout.json").structured_output);
}
