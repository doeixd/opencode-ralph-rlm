import path from "node:path";
import { CONFIG_DEFAULTS, loadConfig, type RalphConfigInput, type ResolvedConfig } from "./config.js";
import { fileExists, readTextFile, writeTextFile } from "./fs.js";
import { PROTOCOL_FILES } from "./protocol-files.js";
import { createOpencodeRuntime } from "./opencode-client.js";

export type SetupDiagnostics = {
  ready: boolean;
  issues: string[];
  warnings: string[];
  suggestions: string[];
};

export type DoctorReport = SetupDiagnostics & {
  worktree: string;
  opencode?: { healthy: boolean; baseUrl: string; version?: string; error?: string };
  provider?: { healthy: boolean; baseUrl: string; error?: string };
};

export async function detectProjectDefaults(
  root: string
): Promise<{ verify: string[]; install: string }> {
  const exists = async (file: string) => fileExists(path.join(root, file));

  if ((await exists("bun.lockb")) || (await exists("bun.lock"))) {
    return { verify: ["bun", "run", "verify"], install: "bun install" };
  }
  if (await exists("yarn.lock")) {
    return { verify: ["yarn", "test"], install: "yarn install" };
  }
  if (await exists("pnpm-lock.yaml")) {
    return { verify: ["pnpm", "test"], install: "pnpm install" };
  }
  if (await exists("package.json")) {
    return { verify: ["npm", "test"], install: "npm install" };
  }
  if (await exists("Cargo.toml")) {
    return { verify: ["cargo", "test"], install: "cargo build" };
  }
  if (await exists("requirements.txt")) {
    return { verify: ["python", "-m", "pytest"], install: "pip install -r requirements.txt" };
  }
  if (await exists("pyproject.toml")) {
    return { verify: ["python", "-m", "pytest"], install: "pip install ." };
  }
  if (await exists("Makefile")) {
    return { verify: ["make", "test"], install: "make" };
  }

  return { verify: ["bun", "run", "verify"], install: "bun install" };
}

export async function checkSetup(
  root: string,
  cfg: ResolvedConfig = CONFIG_DEFAULTS
): Promise<SetupDiagnostics> {
  const diagnostics: SetupDiagnostics = {
    ready: true,
    issues: [],
    warnings: [],
    suggestions: [],
  };

  if (!cfg.verify || cfg.verify.command.length === 0) {
    diagnostics.ready = false;
    diagnostics.issues.push("Missing verify.command in .opencode/ralph.json.");
    const defaults = await detectProjectDefaults(root);
    diagnostics.suggestions.push(
      `Set verify.command, e.g. ${JSON.stringify(defaults.verify)}.`
    );
  }

  const planPath = path.join(root, PROTOCOL_FILES.PLAN);
  if (!(await fileExists(planPath))) {
    diagnostics.ready = false;
    diagnostics.issues.push("Missing PLAN.md.");
    diagnostics.suggestions.push(
      "Start a loop with start_loop (bootstraps protocol files) or create PLAN.md manually."
    );
  } else {
    const planRaw = await readTextFile(planPath).catch(() => "");
    if (planRaw.includes("(fill in)")) {
      diagnostics.warnings.push("PLAN.md still contains placeholders.");
      diagnostics.suggestions.push(
        "Define goals, milestones, and stopping conditions before long runs."
      );
    }
  }

  if (cfg.agentMdPath.trim().length > 0) {
    const agentMdPath = path.join(root, cfg.agentMdPath);
    if (!(await fileExists(agentMdPath))) {
      diagnostics.warnings.push(`${cfg.agentMdPath} is missing.`);
      diagnostics.suggestions.push(
        "Create AGENT.md with static project rules to improve consistency across attempts."
      );
    }
  }

  const workerPlugin = path.join(root, ".opencode", "plugins", "ralph-worker.ts");
  if (!(await fileExists(workerPlugin))) {
    diagnostics.warnings.push("Worker plugin not found at .opencode/plugins/ralph-worker.ts.");
    diagnostics.suggestions.push(
      "Install the ralph-worker plugin so workers get RLM tools and context gating."
    );
  }

  return diagnostics;
}

async function ensureRalphJsonVerify(
  root: string,
  defaults: { verify: string[]; install: string }
): Promise<boolean> {
  const cfgPath = path.join(root, ".opencode", "ralph.json");
  let raw: RalphConfigInput = {};

  if (await fileExists(cfgPath)) {
    try {
      raw = JSON.parse(await readTextFile(cfgPath)) as RalphConfigInput;
    } catch {
      return false;
    }
  }

  if (raw.verify && raw.verify.command.length > 0) {
    return false;
  }

  const next: RalphConfigInput = {
    ...raw,
    enabled: raw.enabled ?? true,
    verify: { command: defaults.verify },
  };
  await writeTextFile(cfgPath, `${JSON.stringify(next, null, 2)}\n`);
  return true;
}

export async function runDoctor(options: {
  worktree: string;
  autofix?: boolean;
  opencodeUrl?: string;
  providerPort?: number;
}): Promise<DoctorReport> {
  const worktree = path.resolve(options.worktree);
  const cfg = await loadConfig(worktree);
  const diagnostics = await checkSetup(worktree, cfg);

  if (options.autofix && (!cfg.verify || cfg.verify.command.length === 0)) {
    const defaults = await detectProjectDefaults(worktree);
    const fixed = await ensureRalphJsonVerify(worktree, defaults);
    if (fixed) {
      diagnostics.suggestions.push(
        `Autofixed verify.command → ${JSON.stringify(defaults.verify)}`
      );
      const refreshed = await loadConfig(worktree);
      if (refreshed.verify && refreshed.verify.command.length > 0) {
        const verifyIssue = diagnostics.issues.indexOf(
          "Missing verify.command in .opencode/ralph.json."
        );
        if (verifyIssue >= 0) {
          diagnostics.issues.splice(verifyIssue, 1);
        }
        diagnostics.ready = diagnostics.issues.length === 0;
      }
    }
  }

  const report: DoctorReport = {
    ...diagnostics,
    worktree,
  };

  const opencodeUrl =
    options.opencodeUrl ?? process.env.OPENCODE_BASE_URL ?? "http://127.0.0.1:4096";
  const runtime = createOpencodeRuntime({ baseUrl: opencodeUrl });
  const opencodeHealth = await runtime.health();
  report.opencode = {
    baseUrl: opencodeUrl,
    ...opencodeHealth,
  };
  if (!opencodeHealth.healthy) {
    diagnostics.warnings.push(
      `OpenCode server not reachable at ${opencodeUrl}${opencodeHealth.error ? `: ${opencodeHealth.error}` : "."}`
    );
    diagnostics.suggestions.push("Start OpenCode (opencode) before running loops.");
  }

  const providerPort = options.providerPort ?? Number(process.env.RALPH_PROVIDER_PORT ?? 8787);
  const providerUrl = `http://127.0.0.1:${providerPort}/api/health`;
  try {
    const response = await fetch(providerUrl, { signal: AbortSignal.timeout(3000) });
    if (response.ok) {
      report.provider = { healthy: true, baseUrl: `http://127.0.0.1:${providerPort}` };
    } else {
      report.provider = {
        healthy: false,
        baseUrl: `http://127.0.0.1:${providerPort}`,
        error: `HTTP ${response.status}`,
      };
      diagnostics.warnings.push(`Ralph provider returned HTTP ${response.status}.`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    report.provider = {
      healthy: false,
      baseUrl: `http://127.0.0.1:${providerPort}`,
      error: message,
    };
    diagnostics.warnings.push(
      `Ralph provider not reachable at http://127.0.0.1:${providerPort}.`
    );
    diagnostics.suggestions.push("Run `bun run ralph-serve` before selecting ralph-rlm/supervisor.");
  }

  return report;
}

export function formatDoctorReport(report: DoctorReport): string {
  const lines = [
    `Ralph doctor — ${report.worktree}`,
    `Ready: ${report.ready ? "yes" : "no"}`,
  ];

  if (report.opencode) {
    lines.push(
      `OpenCode (${report.opencode.baseUrl}): ${report.opencode.healthy ? "ok" : "unreachable"}`
    );
  }
  if (report.provider) {
    lines.push(
      `Provider (${report.provider.baseUrl}): ${report.provider.healthy ? "ok" : "unreachable"}`
    );
  }

  for (const issue of report.issues) lines.push(`ISSUE: ${issue}`);
  for (const warning of report.warnings) lines.push(`WARN: ${warning}`);
  for (const suggestion of report.suggestions) lines.push(`HINT: ${suggestion}`);

  return lines.join("\n");
}