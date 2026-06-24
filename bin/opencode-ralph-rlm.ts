#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import {
  formatDoctorReport,
  formatSetupResult,
  loadPlanContext,
  PROTOCOL_FILES,
  runDoctor,
  setupProject,
} from "@doeixd/opencode-ralph-rlm-engine";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const providerDir = join(root, "packages", "provider");
const builtProviderEntry = join(providerDir, ".output", "server", "index.mjs");

function readFlagValue(args: string[], names: string[]): string | undefined {
  for (const name of names) {
    const inlinePrefix = `${name}=`;
    const inline = args.find((arg) => arg.startsWith(inlinePrefix));
    if (inline) return inline.slice(inlinePrefix.length);

    const index = args.indexOf(name);
    if (index >= 0) {
      const next = args[index + 1];
      if (next && !next.startsWith("-")) return next;
    }
  }
  return undefined;
}

function hasFlag(args: string[], names: string[]): boolean {
  return names.some((name) => args.includes(name));
}

function help(): string {
  return [
    "opencode-ralph-rlm",
    "",
    "Usage:",
    "  opencode-ralph-rlm setup [--worktree .] [--port 8787] [--force] [--dry-run]",
    "  opencode-ralph-rlm serve [--worktree .] [--port 8787] [--opencode-url http://127.0.0.1:4096]",
    "  opencode-ralph-rlm doctor [--worktree .] [--autofix] [--port 8787]",
    "  opencode-ralph-rlm send-message --session <id> --message <text> [--url http://127.0.0.1:8787] [--source <label>] [--no-run] [--no-toast]",
    "  opencode-ralph-rlm sessions [--url http://127.0.0.1:8787]",
    "  opencode-ralph-rlm plan-path [--worktree .]   # where the active plan's PLAN.md is read from",
    "",
    "Aliases:",
    "  init     setup",
    "  start    serve",
    "",
    "Examples:",
    "  npx @doeixd/opencode-ralph-rlm setup",
    "  opencode-ralph-rlm serve --worktree .",
    "  opencode-ralph-rlm sessions",
    "  opencode-ralph-rlm send-message -s <id> -m \"CI went red — pause and replan.\"",
  ].join("\n");
}

function numericPort(raw: string | undefined): number {
  const value = Number(raw ?? process.env.RALPH_PROVIDER_PORT ?? 8787);
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error(`Invalid port: ${raw}`);
  }
  return value;
}

async function runServe(args: string[]): Promise<void> {
  const port = numericPort(readFlagValue(args, ["--port", "-p"]));
  const opencodeUrl =
    readFlagValue(args, ["--opencode-url", "--opencode"]) ??
    process.env.OPENCODE_BASE_URL ??
    "http://127.0.0.1:4096";
  const worktree = resolve(
    readFlagValue(args, ["--worktree", "-w"]) ??
      process.env.RALPH_WORKTREE ??
      process.cwd()
  );

  const env = {
    ...process.env,
    RALPH_PROVIDER_PORT: String(port),
    RALPH_WORKTREE: worktree,
    OPENCODE_BASE_URL: opencodeUrl,
    NITRO_PORT: String(port),
    PORT: String(port),
    HOST: "127.0.0.1",
  };

  console.log(`[ralph] Starting provider on http://127.0.0.1:${port}`);
  console.log(`[ralph] OpenAPI docs: http://127.0.0.1:${port}/_scalar`);
  console.log(`[ralph] OpenCode SDK target: ${opencodeUrl}`);
  console.log(`[ralph] Worktree: ${worktree}`);

  const child = existsSync(builtProviderEntry)
    ? spawn(process.execPath, [builtProviderEntry], {
        cwd: root,
        env,
        stdio: "inherit",
        shell: process.platform === "win32",
      })
    : spawn("npx", ["nitro", "dev", "--port", String(port), "--host", "127.0.0.1"], {
        cwd: providerDir,
        env,
        stdio: "inherit",
        shell: process.platform === "win32",
      });

  await new Promise<void>((resolve) => {
    child.on("exit", (code) => {
      process.exitCode = code ?? 0;
      resolve();
    });
  });
}

function resolveProviderUrl(args: string[]): string {
  const explicit = readFlagValue(args, ["--url", "-u"]);
  if (explicit) return explicit.replace(/\/+$/, "");
  const port = numericPort(readFlagValue(args, ["--port", "-p"]));
  return `http://127.0.0.1:${port}`;
}

async function runSendMessage(args: string[]): Promise<void> {
  const session = readFlagValue(args, ["--session", "-s"]);
  const message = readFlagValue(args, ["--message", "-m"]);
  if (!session || !message) {
    throw new Error(
      "send-message requires --session <id> and --message <text>. Run `sessions` to list active loop sessions."
    );
  }
  const url = `${resolveProviderUrl(args)}/api/loops/${encodeURIComponent(session)}/message`;
  const payload: Record<string, unknown> = { message };
  const source = readFlagValue(args, ["--source"]);
  if (source) payload.source = source;
  if (hasFlag(args, ["--no-run"])) payload.runTurn = false;
  if (hasFlag(args, ["--no-toast"])) payload.toast = false;

  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  }).catch((err) => {
    throw new Error(`Could not reach provider at ${url}: ${err instanceof Error ? err.message : String(err)}`);
  });

  const data = (await res.json().catch(() => ({}))) as {
    ok?: boolean;
    error?: string;
    response?: string;
    ran?: boolean;
  };
  if (!res.ok || data.ok === false) {
    throw new Error(`send-message failed (${res.status}): ${data.error ?? "unknown error"}`);
  }
  if (data.ran && data.response) {
    console.log(data.response);
  } else {
    console.log("Message recorded.");
  }
}

async function runPlanPath(args: string[]): Promise<void> {
  const worktree = resolve(readFlagValue(args, ["--worktree", "-w"]) ?? process.cwd());
  const ctx = await loadPlanContext(worktree);
  const rel = ctx.protocolRel ? `${ctx.protocolRel}/${PROTOCOL_FILES.PLAN}` : PROTOCOL_FILES.PLAN;
  // Print the worktree-relative path the active plan reads PLAN.md from, so a
  // planning skill / script writes it where start_loop will detect it.
  console.log(rel);
}

async function runListSessions(args: string[]): Promise<void> {
  const url = `${resolveProviderUrl(args)}/api/loops`;
  const res = await fetch(url).catch((err) => {
    throw new Error(`Could not reach provider at ${url}: ${err instanceof Error ? err.message : String(err)}`);
  });
  const data = (await res.json().catch(() => ({}))) as {
    loops?: Array<{ sessionId?: string; attempt?: number; outcome?: string }>;
  };
  const loops = data.loops ?? [];
  if (loops.length === 0) {
    console.log("No active loop sessions.");
    return;
  }
  for (const loop of loops) {
    console.log(`${loop.sessionId ?? "?"}\tattempt=${loop.attempt ?? "?"}\t${loop.outcome ?? ""}`.trim());
  }
}

async function main(): Promise<void> {
  const [rawCommand, ...args] = process.argv.slice(2);
  const command = rawCommand ?? "help";

  if (command === "help" || command === "--help" || command === "-h") {
    console.log(help());
    return;
  }

  if (command === "setup" || command === "init") {
    const result = await setupProject({
      worktree: resolve(readFlagValue(args, ["--worktree", "-w"]) ?? process.cwd()),
      port: numericPort(readFlagValue(args, ["--port", "-p"])),
      force: hasFlag(args, ["--force"]),
      dryRun: hasFlag(args, ["--dry-run"]),
      writeProviderConfig: hasFlag(args, ["--provider-config"]),
    });
    console.log(formatSetupResult(result));
    return;
  }

  if (command === "doctor") {
    const port = numericPort(readFlagValue(args, ["--port", "-p"]));
    const report = await runDoctor({
      worktree: resolve(readFlagValue(args, ["--worktree", "-w"]) ?? process.cwd()),
      autofix: hasFlag(args, ["--autofix"]),
      opencodeUrl: readFlagValue(args, ["--opencode-url", "--opencode"]),
      providerPort: port,
    });
    console.log(formatDoctorReport(report));
    process.exitCode = report.ready ? 0 : 1;
    return;
  }

  if (command === "serve" || command === "start") {
    await runServe(args);
    return;
  }

  if (command === "send-message" || command === "send") {
    await runSendMessage(args);
    return;
  }

  if (command === "sessions") {
    await runListSessions(args);
    return;
  }

  if (command === "plan-path") {
    await runPlanPath(args);
    return;
  }

  throw new Error(`Unknown command: ${command}\n\n${help()}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
