import path from "node:path";
import { detectProjectDefaults } from "./doctor.js";
import { fileExists, readTextFile, writeTextFile } from "./fs.js";

export type SetupOptions = {
  worktree: string;
  port?: number;
  force?: boolean;
  dryRun?: boolean;
  writeProviderConfig?: boolean;
  /** Install the provider auto-start plugin (default true). */
  autostart?: boolean;
};

export type SetupActionStatus = "created" | "updated" | "skipped" | "would-create" | "would-update";

export type SetupAction = {
  file: string;
  status: SetupActionStatus;
  message: string;
};

export type SetupResult = {
  worktree: string;
  actions: SetupAction[];
  nextSteps: string[];
};

const PACKAGE_NAME = "@doeixd/opencode-ralph-rlm";

const WORKER_PLUGIN = `/**
 * Ralph RLM worker plugin.
 * Orchestration lives in the supervisor provider; this plugin is worker-only.
 */
export { RalphWorkerPlugin, RalphWorkerPlugin as default } from "${PACKAGE_NAME}/worker-plugin";
`;

const AUTOSTART_PLUGIN = `/**
 * Ralph provider auto-start.
 *
 * Starts the Ralph provider (\`opencode-ralph-rlm serve\`) when OpenCode loads so
 * you don't have to run it by hand. Idempotent — the serve CLI's pre-flight
 * check refuses to start a duplicate provider. Disable with RALPH_AUTOSTART=0
 * (or delete this file). Provider logs go to <tmp>/opencode-ralph-rlm/provider.log.
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { openSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export const RalphAutostartPlugin = async (ctx) => {
  const flag = (process.env.RALPH_AUTOSTART ?? "").trim().toLowerCase();
  if (flag === "0" || flag === "false" || flag === "no") return {};
  try {
    const cli = join(dirname(createRequire(import.meta.url).resolve("${PACKAGE_NAME}")), "opencode-ralph-rlm.js");
    const port = process.env.RALPH_PROVIDER_PORT?.trim() || "8787";
    const wt = ctx?.worktree && ctx.worktree !== "/" ? ctx.worktree : process.cwd();
    const logDir = join(tmpdir(), "opencode-ralph-rlm");
    try { mkdirSync(logDir, { recursive: true }); } catch {}
    const out = openSync(join(logDir, "provider.log"), "a");
    // Launch with Node (NOT process.execPath — that is the opencode binary here)
    // and pipe stdio to a file (NOT "ignore" — a detached child with ignored
    // stdio is killed on Windows). detached + unref lets the provider outlive
    // OpenCode and be reused on the next launch. windowsHide stops a console
    // window from popping up on Windows.
    const child = spawn("node", [cli, "serve", "--port", port, "--worktree", wt], {
      detached: true,
      stdio: ["ignore", out, out],
      windowsHide: true,
    });
    child.unref();
  } catch {
    // best-effort — provider can still be started with \`opencode-ralph-rlm serve\`
  }
  return {};
};

export default RalphAutostartPlugin;
`;

const SESSION_BRIDGE_PLUGIN = `/**
 * Ralph session bridge.
 *
 * OpenCode does not forward session IDs to custom provider HTTP requests by default.
 * This plugin tracks the active TUI session and injects correlation headers.
 */
import type { Plugin } from "@opencode-ai/plugin";
import type { Event } from "@opencode-ai/sdk";

const PROVIDER_ID = "ralph-rlm";
const SESSION_HEADER = "x-opencode-session-id";

function sanitizeForHeader(value: string): string {
  return value.replace(/[\\r\\n\\x00-\\x1f\\x7f]/g, "").trim();
}

function sessionIdFromEvent(event: Event): string {
  if (event.type !== "session.created" && event.type !== "session.updated" && event.type !== "session.deleted") {
    return "";
  }
  const info = (event.properties as { info?: { id?: string } }).info;
  return sanitizeForHeader(info?.id ?? "");
}

function isRalphProviderRequest(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost" || parsed.port === "8787";
  } catch {
    return false;
  }
}

function withDirectoryParam(url: string, directory: string): string {
  const parsed = new URL(url);
  if (!parsed.searchParams.has("directory") && directory) {
    parsed.searchParams.set("directory", directory);
  }
  return parsed.toString();
}

export const RalphSessionBridgePlugin: Plugin = async ({ client, worktree }) => {
  let currentSessionId = "";

  const log = async (level: "debug" | "info", message: string, extra?: Record<string, unknown>) => {
    await client.app
      .log({
        body: {
          service: "ralph-session-bridge",
          level,
          message,
          ...(extra ? { extra } : {}),
        },
      })
      .catch(() => {});
  };

  return {
    auth: {
      provider: PROVIDER_ID,
      methods: [],
      loader: async () => ({
        fetch: (url: string | URL | Request, init?: RequestInit) => {
          const href = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;

          if (!isRalphProviderRequest(href)) {
            return fetch(url, init);
          }

          const headers = new Headers(init?.headers);
          if (currentSessionId && !headers.has(SESSION_HEADER)) {
            headers.set(SESSION_HEADER, currentSessionId);
          }

          const target = withDirectoryParam(href, worktree);
          return fetch(target, { ...init, headers });
        },
      }),
    },

    event: async ({ event }: { event: Event }) => {
      if (event.type === "session.created") {
        currentSessionId = sessionIdFromEvent(event);
        await log("info", "Session bridge bound", { sessionId: currentSessionId });
      } else if (event.type === "session.updated") {
        currentSessionId = sessionIdFromEvent(event);
      } else if (event.type === "session.deleted") {
        const deletedId = sessionIdFromEvent(event);
        if (deletedId && deletedId === currentSessionId) {
          currentSessionId = "";
        }
      }
    },
  };
};

export default RalphSessionBridgePlugin;
`;

function rel(root: string, filePath: string): string {
  return path.relative(root, filePath).replaceAll(path.sep, "/");
}

function jsonBlock(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function providerBlock(port: number): Record<string, unknown> {
  return {
    npm: "@ai-sdk/openai-compatible",
    name: "Ralph RLM",
    options: {
      // Use localhost, not 127.0.0.1: on Windows, Node/undici can time out
      // connecting to 127.0.0.1 (IPv4 literal) while localhost resolves fine —
      // the cause of "cannot reach the server" when the TUI calls the provider.
      baseURL: `http://localhost:${port}/v1`,
    },
    models: {
      supervisor: {
        name: "Ralph Supervisor (loop orchestrator)",
      },
    },
  };
}

async function hasLocalPackageDependency(root: string): Promise<boolean | undefined> {
  const packageJsonPath = path.join(root, "package.json");
  if (!(await fileExists(packageJsonPath))) return undefined;

  const raw = JSON.parse(await readTextFile(packageJsonPath)) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
  };

  return (
    raw.dependencies?.[PACKAGE_NAME] !== undefined ||
    raw.devDependencies?.[PACKAGE_NAME] !== undefined ||
    raw.peerDependencies?.[PACKAGE_NAME] !== undefined
  );
}

async function writeManagedFile(
  root: string,
  filePath: string,
  content: string,
  options: Pick<SetupOptions, "force" | "dryRun">,
  message: string
): Promise<SetupAction> {
  const exists = await fileExists(filePath);
  if (exists && !options.force) {
    return {
      file: rel(root, filePath),
      status: "skipped",
      message: "exists; pass --force to overwrite",
    };
  }

  const status: SetupActionStatus = exists
    ? options.dryRun ? "would-update" : "updated"
    : options.dryRun ? "would-create" : "created";

  if (!options.dryRun) {
    await writeTextFile(filePath, content);
  }

  return { file: rel(root, filePath), status, message };
}

async function mergeOpencodeJson(
  root: string,
  filePath: string,
  port: number,
  dryRun?: boolean
): Promise<SetupAction> {
  let current: Record<string, unknown> = {};
  const exists = await fileExists(filePath);

  if (exists) {
    const raw = await readTextFile(filePath);
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        current = parsed as Record<string, unknown>;
      } else {
        throw new Error("root JSON value is not an object");
      }
    } catch (err) {
      throw new Error(`Cannot merge ${rel(root, filePath)}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const providerRaw = current.provider;
  const provider =
    typeof providerRaw === "object" && providerRaw !== null && !Array.isArray(providerRaw)
      ? { ...(providerRaw as Record<string, unknown>) }
      : {};

  const next = {
    ...current,
    $schema:
      typeof current.$schema === "string" ? current.$schema : "https://opencode.ai/config.json",
    provider: {
      ...provider,
      "ralph-rlm": providerBlock(port),
    },
  };

  const changed = JSON.stringify(current) !== JSON.stringify(next);
  const status: SetupActionStatus = !exists
    ? dryRun ? "would-create" : "created"
    : changed
      ? dryRun ? "would-update" : "updated"
      : "skipped";

  if (changed && !dryRun) {
    await writeTextFile(filePath, jsonBlock(next));
  }

  return {
    file: rel(root, filePath),
    status,
    message: changed ? "registered ralph-rlm/supervisor provider" : "ralph provider already registered",
  };
}

export async function setupProject(options: SetupOptions): Promise<SetupResult> {
  const worktree = path.resolve(options.worktree);
  const port = options.port ?? 8787;
  const defaults = await detectProjectDefaults(worktree);
  const actions: SetupAction[] = [];
  const hasLocalPackage = await hasLocalPackageDependency(worktree).catch(() => undefined);

  actions.push(
    await writeManagedFile(
      worktree,
      path.join(worktree, ".opencode", "plugins", "ralph-worker.ts"),
      WORKER_PLUGIN,
      options,
      "installed worker plugin wrapper"
    )
  );
  actions.push(
    await writeManagedFile(
      worktree,
      path.join(worktree, ".opencode", "plugins", "ralph-session-bridge.ts"),
      SESSION_BRIDGE_PLUGIN,
      options,
      "installed session bridge plugin"
    )
  );

  if (options.autostart !== false) {
    actions.push(
      await writeManagedFile(
        worktree,
        path.join(worktree, ".opencode", "plugins", "ralph-autostart.ts"),
        AUTOSTART_PLUGIN,
        options,
        "installed provider auto-start plugin (disable with RALPH_AUTOSTART=0)"
      )
    );
  }

  actions.push(
    await writeManagedFile(
      worktree,
      path.join(worktree, ".opencode", "ralph.json"),
      jsonBlock({
        enabled: true,
        maxAttempts: 20,
        verifyTimeoutMinutes: 15,
        verify: { command: defaults.verify, cwd: "." },
        gateDestructiveToolsUntilContextLoaded: true,
        subAgentEnabled: true,
        plans: { dir: ".ralph-rlm/plans", active: "default" },
        swarm: {
          enabled: true,
          maxConcurrent: 5,
          unsafeEvalEnabled: false,
        },
      }),
      options,
      `configured verify.command as ${JSON.stringify(defaults.verify)}`
    )
  );

  if (options.writeProviderConfig) {
    actions.push(
      await writeManagedFile(
        worktree,
        path.join(worktree, ".opencode", "ralph-provider.json"),
        jsonBlock({
          supervisor: {
            baseUrl: "https://api.openai.com/v1",
            modelID: "gpt-5.4-mini",
            maxToolRounds: 8,
          },
          worker: {
            providerID: "opencode",
            modelID: "deepseek-v4-flash-free",
          },
        }),
        options,
        "wrote optional supervisor/worker model config"
      )
    );
  }

  actions.push(await mergeOpencodeJson(worktree, path.join(worktree, "opencode.json"), port, options.dryRun));

  if (hasLocalPackage === false) {
    actions.push({
      file: "package.json",
      status: "skipped",
      message: `${PACKAGE_NAME} is not listed; install it locally so OpenCode can resolve the worker plugin`,
    });
  }

  return {
    worktree,
    actions,
    nextSteps: [
      hasLocalPackage === true
        ? "Package dependency is present."
        : `Install this package in the target project: npm install -D ${PACKAGE_NAME}`,
      `Start the provider: opencode-ralph-rlm serve --worktree . --port ${port}`,
      "Open OpenCode and select model ralph-rlm/supervisor.",
    ],
  };
}

export function formatSetupResult(result: SetupResult): string {
  const lines = [`Ralph setup — ${result.worktree}`];
  for (const action of result.actions) {
    lines.push(`${action.status.toUpperCase()}: ${action.file} — ${action.message}`);
  }
  lines.push("");
  lines.push("Next steps:");
  for (const step of result.nextSteps) {
    lines.push(`- ${step}`);
  }
  return lines.join("\n");
}
