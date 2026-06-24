import path from "node:path";
import { spawn } from "node:child_process";
import { isSwarmUnsafeEvalEnabled, loadConfig, type ResolvedSwarmConfig } from "./config.js";
import { writeTextFile } from "./fs.js";
import { nowISO } from "./text.js";

export type SwarmScriptRunInput = {
  worktree: string;
  swarmId: string;
  code: string;
  timeoutMinutes?: number;
};

export type SwarmScriptRunResult = {
  ok: boolean;
  swarmId: string;
  scriptPath: string;
  runner: "deno" | "bun";
  unsafe: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  error?: string;
};

const SWARM_RUNS_DIR = ".opencode/swarm/runs";

function buildRunnerSource(
  userCode: string,
  runner: "deno" | "bun",
  maxSpawns: number
): string {
  const sdkImport =
    runner === "deno"
      ? 'import { createOpencodeClient } from "npm:@opencode-ai/sdk/v2/client";'
      : 'import { createOpencodeClient } from "@opencode-ai/sdk/v2/client";';

  return [
    sdkImport,
    "",
    "const client = createOpencodeClient({",
    "  baseUrl: process.env.OPENCODE_BASE_URL ?? 'http://127.0.0.1:4096',",
    "});",
    "const directory = process.env.RALPH_WORKTREE ?? process.cwd();",
    "const runId = process.env.RALPH_SWARM_RUN_ID ?? 'swarm-script';",
    "",
    "async function report(payload: unknown): Promise<void> {",
    '  console.log(JSON.stringify({ type: "swarm.report", payload }));',
    "}",
    "",
    "async function sleep(ms: number): Promise<void> {",
    "  await new Promise((resolve) => setTimeout(resolve, ms));",
    "}",
    "",
    `const __ralph_maxSpawns = ${maxSpawns};`,
    "let __ralph_spawnCount = 0;",
    "const __ralph_sessionCreate = client.session.create.bind(client.session);",
    "client.session.create = async (...args: unknown[]) => {",
    "  __ralph_spawnCount += 1;",
    "  if (__ralph_spawnCount > __ralph_maxSpawns) {",
    "    throw new Error(`swarm script spawn cap exceeded (${__ralph_maxSpawns})`);",
    "  }",
    "  return __ralph_sessionCreate(...args);",
    "};",
    "",
    "const ctx = { client, directory, report, sleep, runId };",
    "Object.assign(globalThis, { client, directory, report, sleep, runId, ctx });",
    "",
    "const __ralph_user_main = async () => {",
    userCode,
    "};",
    "",
    "await __ralph_user_main();",
    "",
  ].join("\n");
}

async function commandExists(command: string, args: string[]): Promise<boolean> {
  return await new Promise((resolve) => {
    const child = spawn(command, args, { stdio: "ignore", shell: process.platform === "win32" });
    child.on("error", () => resolve(false));
    child.on("exit", (code) => resolve(code === 0));
  });
}

async function pickRunner(
  swarm: ResolvedSwarmConfig,
  unsafe: boolean
): Promise<"deno" | "bun"> {
  if (swarm.scriptRunner === "bun") return "bun";
  if (swarm.scriptRunner === "deno") {
    const hasDeno = await commandExists("deno", ["--version"]);
    if (!hasDeno) throw new Error("swarm.scriptRunner is 'deno' but Deno is not installed");
    return "deno";
  }

  const hasDeno = await commandExists("deno", ["--version"]);
  if (hasDeno && !unsafe) return "deno";
  return "bun";
}

function parseOpencodePort(baseUrl: string): string {
  try {
    const url = new URL(baseUrl);
    return url.port || (url.protocol === "https:" ? "443" : "80");
  } catch {
    return "4096";
  }
}

async function runSubprocess(
  command: string,
  args: string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    timeoutMs: number;
  }
): Promise<{ exitCode: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  return await new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      shell: process.platform === "win32",
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, options.timeoutMs);

    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({
        exitCode: null,
        stdout,
        stderr: `${stderr}\n${String(err)}`.trim(),
        timedOut,
      });
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        stderr = `${stderr}\n[ralph] swarm script timed out`.trim();
      }
      resolve({ exitCode: code, stdout, stderr, timedOut });
    });
  });
}

export async function runSwarmScript(input: SwarmScriptRunInput): Promise<SwarmScriptRunResult> {
  const cfg = await loadConfig(input.worktree);
  const unsafe = isSwarmUnsafeEvalEnabled(cfg.swarm);
  if (!unsafe) {
    return {
      ok: false,
      swarmId: input.swarmId,
      scriptPath: "",
      runner: "bun",
      unsafe: false,
      exitCode: null,
      stdout: "",
      stderr: "",
      error:
        "swarm_unsafe_runtime_code_eval is disabled. Set swarm.unsafeEvalEnabled=true in ralph.json or RALPH_SWARM_UNSAFE_EVAL=1.",
    };
  }

  const code = input.code.trim();
  if (!code) {
    return {
      ok: false,
      swarmId: input.swarmId,
      scriptPath: "",
      runner: "bun",
      unsafe: true,
      exitCode: null,
      stdout: "",
      stderr: "",
      error: "code is required",
    };
  }

  const runner = await pickRunner(cfg.swarm, true);
  const runDir = path.join(input.worktree, SWARM_RUNS_DIR, input.swarmId);
  const scriptPath = path.join(runDir, "script.ts");
  const runnerSource = buildRunnerSource(code, runner, cfg.swarm.maxUnsafeScriptSpawns);
  await writeTextFile(scriptPath, runnerSource);
  await writeTextFile(
    path.join(runDir, "meta.json"),
    JSON.stringify({ swarmId: input.swarmId, createdAt: nowISO(), unsafe: true }, null, 2)
  );

  const timeoutMinutes = input.timeoutMinutes ?? cfg.swarm.defaultTimeoutMinutes;
  const timeoutMs = timeoutMinutes * 60_000;
  const opencodeUrl = process.env.OPENCODE_BASE_URL ?? "http://127.0.0.1:4096";
  void parseOpencodePort(opencodeUrl);

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    OPENCODE_BASE_URL: opencodeUrl,
    RALPH_WORKTREE: input.worktree,
    RALPH_SWARM_RUN_ID: input.swarmId,
  };

  let result;
  if (runner === "deno") {
    result = await runSubprocess(
      "deno",
      ["run", "--allow-all", scriptPath],
      { cwd: input.worktree, env, timeoutMs }
    );
  } else {
    result = await runSubprocess("bun", ["run", scriptPath], {
      cwd: input.worktree,
      env,
      timeoutMs,
    });
  }

  return {
    ok: result.exitCode === 0 && !result.timedOut,
    swarmId: input.swarmId,
    scriptPath,
    runner,
    unsafe: true,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    ...(result.timedOut ? { error: `Script timed out after ${timeoutMinutes} minutes` } : {}),
  };
}

export function isUnsafeEvalAllowed(worktree: string): Promise<boolean> {
  return loadConfig(worktree).then((cfg) => isSwarmUnsafeEvalEnabled(cfg.swarm));
}