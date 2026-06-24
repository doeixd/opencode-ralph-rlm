import path from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { describe, expect, test, afterEach } from "bun:test";
import { detectOpencodeSupervisorCreds } from "../lib/opencode-auth.js";
import { loadSupervisorLlmConfig } from "../lib/supervisor-config.js";

const ENV_KEYS = [
  "RALPH_OPENCODE_AUTH_PATH",
  "RALPH_SUPERVISOR_API_KEY",
  "RALPH_SUPERVISOR_MODEL",
  "RALPH_SUPERVISOR_BASE_URL",
] as const;

async function writeAuth(contents: unknown): Promise<{ dir: string; authPath: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), "ralph-auth-"));
  const authPath = path.join(dir, "auth.json");
  await writeFile(authPath, JSON.stringify(contents), "utf8");
  return { dir, authPath };
}

describe("detectOpencodeSupervisorCreds", () => {
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  test("uses a keyed provider (opencode-go) and maps the Zen endpoint", async () => {
    const { dir, authPath } = await writeAuth({
      anthropic: { type: "oauth", access: "x" },
      "opencode-go": { type: "api", key: "zen-key-123" },
    });
    try {
      process.env.RALPH_OPENCODE_AUTH_PATH = authPath;
      const creds = await detectOpencodeSupervisorCreds();
      expect(creds?.apiKey).toBe("zen-key-123");
      expect(creds?.baseUrl).toBe("https://opencode.ai/zen/v1");
      expect(creds?.source).toBe("opencode-auth:opencode-go");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("skips OAuth-only providers", async () => {
    const { dir, authPath } = await writeAuth({
      openai: { type: "oauth", access: "x" },
      anthropic: { type: "oauth", access: "y" },
    });
    try {
      process.env.RALPH_OPENCODE_AUTH_PATH = authPath;
      expect(await detectOpencodeSupervisorCreds()).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("returns null when no auth file exists", async () => {
    process.env.RALPH_OPENCODE_AUTH_PATH = path.join(tmpdir(), "does-not-exist-xyz", "auth.json");
    expect(await detectOpencodeSupervisorCreds()).toBeNull();
  });

  test("loadSupervisorLlmConfig falls back to OpenCode auth when no key is set", async () => {
    const { dir, authPath } = await writeAuth({
      google: { type: "api", key: "g-key" },
    });
    const worktree = await mkdtemp(path.join(tmpdir(), "ralph-wt-"));
    try {
      delete process.env.RALPH_SUPERVISOR_API_KEY;
      delete process.env.RALPH_SUPERVISOR_MODEL;
      delete process.env.RALPH_SUPERVISOR_BASE_URL;
      process.env.RALPH_OPENCODE_AUTH_PATH = authPath;

      const cfg = await loadSupervisorLlmConfig(worktree);
      expect(cfg.apiKey).toBe("g-key");
      expect(cfg.source).toBe("opencode-auth:google");
      expect(cfg.model).toBe("gemini-2.5-flash");
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(worktree, { recursive: true, force: true });
    }
  });

  test("env key wins over auto-detect", async () => {
    const { dir, authPath } = await writeAuth({ google: { type: "api", key: "g-key" } });
    const worktree = await mkdtemp(path.join(tmpdir(), "ralph-wt-"));
    try {
      process.env.RALPH_OPENCODE_AUTH_PATH = authPath;
      process.env.RALPH_SUPERVISOR_API_KEY = "my-explicit-key";
      const cfg = await loadSupervisorLlmConfig(worktree);
      expect(cfg.apiKey).toBe("my-explicit-key");
      expect(cfg.source).toBe("env");
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(worktree, { recursive: true, force: true });
    }
  });
});
