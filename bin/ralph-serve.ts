#!/usr/bin/env bun
/**
 * Start the Ralph RLM provider (Nitro via Vite) or run setup diagnostics.
 *
 * Usage:
 *   bun run ralph-serve
 *   bun run ralph-serve -- --port 8787
 *   bun run ralph-serve -- --opencode-url http://127.0.0.1:4096
 *   bun run ralph-serve -- --doctor [--autofix] [--worktree .]
 */
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join, resolve } from "path";
import { formatDoctorReport, runDoctor } from "@doeixd/opencode-ralph-rlm-engine";

const __dirname = dirname(fileURLToPath(import.meta.url));
const providerDir = join(__dirname, "..", "packages", "provider");

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

const args = process.argv.slice(2);
const doctorMode = hasFlag(args, ["--doctor"]);
const autofix = hasFlag(args, ["--autofix"]);
const worktree = resolve(
  readFlagValue(args, ["--worktree", "-w"]) ??
    process.env.RALPH_WORKTREE ??
    process.cwd()
);
const portValue =
  readFlagValue(args, ["--port", "-p"]) ?? process.env.RALPH_PROVIDER_PORT ?? "8787";
const opencodeUrl =
  readFlagValue(args, ["--opencode-url", "--opencode"]) ??
  process.env.OPENCODE_BASE_URL ??
  "http://127.0.0.1:4096";

if (doctorMode) {
  const report = await runDoctor({
    worktree,
    autofix,
    opencodeUrl,
    providerPort: Number(portValue),
  });
  console.log(formatDoctorReport(report));
  process.exit(report.ready ? 0 : 1);
}

const env = {
  ...process.env,
  RALPH_PROVIDER_PORT: portValue,
  OPENCODE_BASE_URL: opencodeUrl,
};

console.log(`[ralph-serve] Starting provider on http://127.0.0.1:${portValue}`);
console.log(`[ralph-serve] OpenAPI docs: http://127.0.0.1:${portValue}/_scalar`);
console.log(`[ralph-serve] OpenCode SDK target: ${opencodeUrl}`);

const child = spawn("bunx", ["nitro", "dev", "--port", String(portValue), "--host", "127.0.0.1"], {
  cwd: providerDir,
  env,
  stdio: "inherit",
  shell: process.platform === "win32",
});

child.on("exit", (code) => {
  process.exit(code ?? 0);
});