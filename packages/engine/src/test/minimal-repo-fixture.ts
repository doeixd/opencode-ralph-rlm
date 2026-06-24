import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * The minimal fixture repo used by the loop/verify tests. Materialized at test
 * time (and git-ignored) so it doesn't live in version control. `verify.mjs`
 * passes only once `.ralph-pass-marker` exists, which drives fail→pass tests.
 */
const FILES: Record<string, string> = {
  "package.json": `${JSON.stringify(
    {
      name: "ralph-minimal-fixture",
      private: true,
      type: "module",
      scripts: { verify: "node scripts/verify.mjs" },
    },
    null,
    2
  )}\n`,
  ".opencode/ralph.json": `${JSON.stringify(
    {
      enabled: true,
      maxAttempts: 5,
      verify: { command: ["node", "scripts/verify.mjs"], cwd: "." },
    },
    null,
    2
  )}\n`,
  ".opencode/loop_attempt.json": `${JSON.stringify(
    {
      attempt: 1,
      sessionId: "smoke-session-b",
      updatedAt: "2026-06-15T17:02:22.249Z",
      workerSessionId: "worker-1781542942245",
    },
    null,
    2
  )}\n`,
  "scripts/verify.mjs": `import { existsSync } from "node:fs";

if (existsSync(".ralph-pass-marker")) {
  console.log("PASS");
  process.exit(0);
}

console.error("FAIL: .ralph-pass-marker missing");
process.exit(1);
`,
};

/** Write the minimal fixture repo into `root` (idempotent). Returns `root`. */
export async function ensureMinimalRepoFixture(root: string): Promise<string> {
  for (const [rel, content] of Object.entries(FILES)) {
    const dest = path.join(root, rel);
    await mkdir(path.dirname(dest), { recursive: true });
    await writeFile(dest, content);
  }
  return root;
}
