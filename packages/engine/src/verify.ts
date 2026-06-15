import path from "node:path";
import { spawn } from "node:child_process";
import type { ResolvedConfig } from "./config.js";

export type VerifyVerdict = "pass" | "fail" | "unknown";

export type VerifyResult = {
  verdict: VerifyVerdict;
  output: string;
  error?: string;
  exitCode?: number | null;
  reason?: string;
};

export type ParsedVerify = {
  verdict: VerifyVerdict;
  details: string;
};

type ActiveCommand = {
  child: ReturnType<typeof spawn>;
  label: string;
  startedAt: number;
  timedOut: boolean;
  timeoutTimer?: ReturnType<typeof setTimeout>;
  killTimer?: ReturnType<typeof setTimeout>;
};

const activeCommands = new Set<ActiveCommand>();

function stopCommand(cmd: ActiveCommand, reason: string): void {
  if (cmd.child.killed) return;
  cmd.timedOut = cmd.timedOut || reason === "timeout";
  try {
    cmd.child.kill();
  } catch {
    // ignore
  }
  cmd.killTimer = setTimeout(() => {
    try {
      cmd.child.kill("SIGKILL");
    } catch {
      // ignore
    }
  }, 2000);
}

export function stopAllVerifyCommands(reason: string): void {
  for (const cmd of activeCommands) {
    stopCommand(cmd, reason);
  }
}

export async function runCommand(
  command: string[],
  cwd: string,
  options?: { timeoutMs?: number; label?: string }
): Promise<{ ok: boolean; code: number | null; stdout: string; stderr: string }> {
  return await new Promise((resolve) => {
    const child = spawn(command[0] ?? "", command.slice(1), {
      cwd,
      env: process.env,
      shell: false,
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    const entry: ActiveCommand = {
      child,
      label: options?.label ?? command.join(" "),
      startedAt: Date.now(),
      timedOut: false,
    };
    activeCommands.add(entry);

    if (options?.timeoutMs && options.timeoutMs > 0) {
      entry.timeoutTimer = setTimeout(() => {
        stopCommand(entry, "timeout");
      }, options.timeoutMs);
    }

    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });

    child.on("error", (err) => {
      if (entry.timeoutTimer) clearTimeout(entry.timeoutTimer);
      if (entry.killTimer) clearTimeout(entry.killTimer);
      activeCommands.delete(entry);
      resolve({ ok: false, code: null, stdout, stderr: `${stderr}\n${String(err)}`.trim() });
    });

    child.on("close", (code) => {
      if (entry.timeoutTimer) clearTimeout(entry.timeoutTimer);
      if (entry.killTimer) clearTimeout(entry.killTimer);
      activeCommands.delete(entry);
      const timeoutNote = entry.timedOut ? "\n[ralph] command timed out" : "";
      resolve({
        ok: code === 0 && !entry.timedOut,
        code,
        stdout,
        stderr: `${stderr}${timeoutNote}`.trim(),
      });
    });
  });
}

export async function runVerify(
  worktree: string,
  config: ResolvedConfig
): Promise<VerifyResult> {
  if (!config.verify || config.verify.command.length === 0) {
    return {
      verdict: "unknown",
      output: "",
      reason: "No verify.command in .opencode/ralph.json.",
    };
  }

  const verifyCmd = config.verify.command;
  const cwd = path.join(worktree, config.verify.cwd ?? ".");
  const timeoutMs =
    config.verifyTimeoutMinutes > 0 ? config.verifyTimeoutMinutes * 60_000 : undefined;

  try {
    const result = await runCommand(verifyCmd, cwd, {
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      label: "verify",
    });

    if (result.ok) {
      return { verdict: "pass", output: result.stdout };
    }

    return {
      verdict: "fail",
      output: result.stdout,
      error: result.stderr,
      exitCode: result.code,
    };
  } catch (err) {
    return {
      verdict: "fail",
      output: "",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export function formatVerifyJson(result: VerifyResult): string {
  return JSON.stringify(result, null, 2);
}

export function parseVerifyResult(raw: string | VerifyResult): ParsedVerify {
  if (typeof raw !== "string") {
    return {
      verdict: raw.verdict,
      details: raw.error ? `${raw.error}\n${raw.output}` : raw.output,
    };
  }

  try {
    const parsed = JSON.parse(raw) as VerifyResult;
    return {
      verdict: parsed.verdict ?? "unknown",
      details: parsed.error ? `${parsed.error}\n${parsed.output ?? ""}` : (parsed.output ?? ""),
    };
  } catch {
    return { verdict: "unknown", details: raw };
  }
}

export async function runAndParseVerify(
  worktree: string,
  config: ResolvedConfig
): Promise<ParsedVerify> {
  const result = await runVerify(worktree, config);
  return parseVerifyResult(result);
}