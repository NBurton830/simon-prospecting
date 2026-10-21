// Captures real `claude -p` output as test fixtures. Uses the logged-in Claude account (a few small calls).
// Usage: npx tsx scripts/capture-claude-fixtures.ts
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analysisJsonSchema } from "@/lib/analysis/schema";
import { SYSTEM_PROMPT } from "@/lib/analysis/prompt";

const OUT = join(__dirname, "fixtures", "claude-code");
mkdirSync(OUT, { recursive: true });

// Hand-written messages in the §5.8 format, for fictional companies.
const BRAND_MESSAGE = `<company>
Name: Fernwood Skin Co
Legal name: Fernwood Skin Co, Inc.
Domain: fernwoodskin.com
HQ state: TX
</company>
<signals>
<signal type="SEC_FORM_D" date="2026-09-14" url="https://www.sec.gov/Archives/edgar/data/9999999/000999999926000001/">
Industry group: Retailing. Total offering: $8,500,000. Amount sold: $6,200,000. First sale: 2026-08-30.
Related persons: Jane Doe (Executive Officer)
</signal>
<signal type="JOB_LISTING" date="2026-10-18" url="https://example.com/jobs/1">
Title: Director of Retail. Location: Austin, TX.
Description: Fernwood Skin Co is a fast-growing clean skincare brand sold online and in 40 Ulta doors. We are opening our first three brand stores in 2027 and want a Director of Retail to lead site selection, pop-up tests in regional malls, and store openings.
</signal>
</signals>
Today's date: 2026-10-21`;

const FUND_MESSAGE = `<company>
Name: Harbor Ridge Capital Fund III
Legal name: Harbor Ridge Capital Fund III, L.P.
Domain: Unknown
HQ state: NY
</company>
<signals>
<signal type="SEC_FORM_D" date="2026-10-20" url="https://www.sec.gov/Archives/edgar/data/9999998/000999999826000001/">
Industry group: Other. Total offering: $50,000,000. Amount sold: $12,000,000. First sale: 2026-10-01.
Related persons: John Roe (Executive Officer)
</signal>
</signals>
Today's date: 2026-10-21`;

function run(name: string, message: string, env: Record<string, string>) {
  const cwd = mkdtempSync(join(tmpdir(), "claude-run-"));
  const args = [
    "-p",
    "--output-format", "json",
    "--json-schema", JSON.stringify(analysisJsonSchema()),
    "--system-prompt", SYSTEM_PROMPT,
    "--tools", "StructuredOutput", // only the tool --json-schema needs; no file, shell, or web access
    "--model", "sonnet",
    "--no-session-persistence",
  ];
  const res = spawnSync("claude", args, { cwd, env: env as NodeJS.ProcessEnv, input: message, encoding: "utf8", timeout: 180_000 });
  writeFileSync(join(OUT, `${name}.stdout.json`), res.stdout);
  writeFileSync(join(OUT, `${name}.meta.json`), JSON.stringify({ exitCode: res.status, stderr: res.stderr }, null, 2));
  console.log(`${name}: exit ${res.status}, ${res.stdout.length} bytes stdout, stderr: ${res.stderr.slice(0, 200)}`);
}

// USER/LOGNAME let the CLI find a keychain login on macOS; CI uses CLAUDE_CODE_OAUTH_TOKEN instead.
const baseEnv: Record<string, string> = {};
for (const k of ["PATH", "HOME", "USER", "LOGNAME", "CLAUDE_CODE_OAUTH_TOKEN"]) {
  if (process.env[k]) baseEnv[k] = process.env[k]!;
}
const only = process.argv[2];
if (!only || only === "success") {
  run("success-brand", BRAND_MESSAGE, baseEnv);
  run("success-excluded-fund", FUND_MESSAGE, baseEnv);
}
if (!only || only === "auth") {
  // Without USER/LOGNAME the macOS keychain login isn't found, which mimics CI.
  const { USER, LOGNAME, CLAUDE_CODE_OAUTH_TOKEN, ...noLogin } = baseEnv;
  run("auth-invalid-token", BRAND_MESSAGE, { ...noLogin, CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-invalid-token-for-fixture" });
  run("auth-not-logged-in", BRAND_MESSAGE, noLogin);
}
